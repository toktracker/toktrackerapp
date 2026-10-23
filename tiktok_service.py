import asyncio
import hashlib
import json
import logging
import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Deque, Dict, List, Optional, Tuple

import httpx

try:
    from TikTokLive import TikTokLiveClient
    from TikTokLive.client.errors import AgeRestrictedError, UserOfflineError
    from TikTokLive.client.web.web_settings import WebDefaults
    from TikTokLive.events import (
        ConnectEvent,
        DisconnectEvent,
        GiftEvent,
        LiveEndEvent,
        RoomUserSeqEvent,
        LinkMicBattleEvent,
        LinkMicArmiesEvent,
        CommentEvent,
    )
    TIKTOKLIVE_AVAILABLE = True

    try:
        from TikTokLive.client.web.routes.fetch_room_id_api import FetchRoomIdAPIRoute

        _orig_parse_room_id = FetchRoomIdAPIRoute.parse_room_id

        def _safe_parse_room_id(data: dict) -> str:
            room_id = _orig_parse_room_id(data)
            if not room_id or str(room_id).strip() in ("", "0"):
                raise UserOfflineError("Streamer ist aktuell offline (leere Room-ID von TikTok Webcast API).")
            return room_id

        FetchRoomIdAPIRoute.parse_room_id = staticmethod(_safe_parse_room_id)

        _orig_fetch_user_room_data = FetchRoomIdAPIRoute.fetch_user_room_data

        async def _safe_fetch_user_room_data(web: Any, unique_id: str) -> dict:
            resp: httpx.Response = await web.get(
                url=WebDefaults.tiktok_app_url + "/api-live/user/room/",
                extra_params={"uniqueId": unique_id, "sourceType": 54},
            )
            if not resp.content or not resp.content.strip():
                raise UserOfflineError(f"Streamer @{unique_id} ist offline (leere Antwort von TikTok Live-API).")
            try:
                data = resp.json()
            except Exception:
                raise UserOfflineError(f"Streamer @{unique_id} ist offline (kein aktiver Live-JSON-Feed).")
            if data.get("message") == "user_not_found":
                raise UserOfflineError(f"Streamer @{unique_id} existiert nicht oder streamt nicht.")
            return data

        FetchRoomIdAPIRoute.fetch_user_room_data = staticmethod(_safe_fetch_user_room_data)
    except Exception as _patch_err:
        logging.getLogger("toktracker.tiktok").debug("TikTokLive Route-Patching Hinweis: %s", _patch_err)

except ImportError:
    TIKTOKLIVE_AVAILABLE = False
    AgeRestrictedError = Exception  # type: ignore
    UserOfflineError = Exception  # type: ignore
    WebDefaults = None  # type: ignore
    LinkMicBattleEvent = None  # type: ignore
    LinkMicArmiesEvent = None  # type: ignore
    CommentEvent = None  # type: ignore


def is_streamer_offline_error(exc: Exception) -> bool:
    """
    Erkennt zuverlässig, ob ein Fehler in Wirklichkeit bedeutet, dass der Streamer schlicht offline ist:
    - UserOfflineError: Standard TikTokLive Exception.
    - ValueError ('invalid literal for int() with base 10: \'\''): TikTok API liefert leere roomId für Offline-User.
    - JSONDecodeError ('Expecting value: line 1 column 1 (char 0)'): TikTok liefert leeren Body für Offline-User.
    - FailedParseRoomIdError: SIGI_STATE HTML-Tag fehlt, weil kein aktiver Stream existiert.
    - UserNotFoundError: Streamer existiert nicht oder hat keinen aktiven Live-Stream.
    """
    if isinstance(exc, UserOfflineError):
        return True
    err_str = str(exc)
    err_cls = type(exc).__name__
    if isinstance(exc, ValueError) and "invalid literal for int()" in err_str:
        return True
    if "JSONDecodeError" in err_cls or ("Expecting value" in err_str and "column 1" in err_str):
        return True
    if err_cls in ("FailedParseRoomIdError", "UserNotFoundError"):
        return True
    return False

from config import config
from database import (
    end_stream_session,
    get_auto_monitor_streamers,
    get_settings,
    record_gift_event,
    start_stream_session,
    update_stream_session_metrics,
    update_streamer_runtime_state,
    record_battle_start,
    update_battle_scores,
    record_battle_finish,
    batch_record_chat_messages,
    cleanup_old_chat_messages,
    get_known_donor_tiers,
    get_donor_tier,
)


logger = logging.getLogger("tiktok_service")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter("[%(asctime)s] [%(levelname)s] %(name)s: %(message)s")
    )
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


def _prewarm_tiktok_proto_schemas() -> None:
    """
    Workaround für TikTokLive v7.0.1 + Pydantic 2.10+ / Python 3.13:
    Einige verschachtelte Dataclasses in `TikTokLiveProto.v3.webcast.model`
    (z.B. `Hashtag`, `FansClubData`, `LiveEventInfo`, `SchemeInfo`) verwenden
    Typ-Annotationen wie `"data.HashtagNamespace"`.
    Wenn zuerst eine äußere Nachricht wie `WebcastLinkLayerMessage` (die ein
    Klassenattribut `data: bytes = b""` besitzt) geparst wird, übergibt Pydantic
    beim verzögerten Rebuild der verschachtelten Klassen den Namensraum der
    äußeren Klasse, wodurch `data` als `b""` statt als Modul aufgelöst wird:
      `AttributeError: 'bytes' object has no attribute 'HashtagNamespace'`
    Durch das einmalige Vorab-Initialisieren dieser Dataclasses auf Top-Level
    werden deren Pydantic-Validatoren im sauberen Modul-Namensraum gebaut.
    """
    if not TIKTOKLIVE_AVAILABLE:
        return
    try:
        from TikTokLiveProto.v3.webcast import model as proto_model

        for cls_name in ("FansClubData", "Hashtag", "LiveEventInfo", "SchemeInfo"):
            cls_obj = getattr(proto_model, cls_name, None)
            if cls_obj is not None:
                try:
                    cls_obj()
                except Exception:
                    pass
    except Exception as exc:
        logger.debug("TikTokLiveProto Schema-Prewarm Hinweis: %s", exc)


_prewarm_tiktok_proto_schemas()

# Falls ein EulerStream Sign-API-Key in .env / Umgebungsvariablen hinterlegt ist, global setzen
if TIKTOKLIVE_AVAILABLE and WebDefaults is not None and config.has_sign_api_key:
    WebDefaults.tiktok_sign_api_key = config.tiktok_sign_api_key

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
}

KNOWN_GIFT_DIAMONDS: Dict[str, int] = {
    "rose": 1,
    "tiktok": 1,
    "gg": 1,
    "ice cream cone": 1,
    "finger heart": 5,
    "mic": 5,
    "rosa": 10,
    "perfume": 20,
    "doughnut": 30,
    "cap": 99,
    "little crown": 99,
    "hearts": 199,
    "corgi": 299,
    "boxing gloves": 299,
    "money gun": 500,
    "swan": 699,
    "galaxy": 1000,
    "fireworks": 1088,
    "whale diving": 2150,
    "motorcycle": 2988,
    "sports car": 7000,
    "sunset speedway": 10000,
    "falcon": 10999,
    "planet": 15000,
    "dragon flame": 26999,
    "lion": 29999,
    "tiktok universe": 44999,
}


def fetch_tiktok_user_info(username: str) -> Dict[str, Any]:
    """
    Fragt TikTok-Web-Endpoints (@username) ab, um Anzeigename, Avatar,
    Follower-Anzahl, Room-ID und aktuellen Live-Status zu ermitteln.
    Nutzt automatisch TIKTOK_SESSION_ID falls in .env konfiguriert.
    """
    clean_user = username.strip().lstrip("@").lower()
    result: Dict[str, Any] = {
        "username": clean_user,
        "display_name": clean_user,
        "avatar_url": "",
        "follower_count": 0,
        "room_id": "",
        "is_live": False,
        "title": "",
    }

    cookies = {}
    if config.has_tiktok_session:
        cookies["sessionid"] = config.tiktok_session_id
        cookies["sessionid_ss"] = config.tiktok_session_id
        cookies["sid_tt"] = config.tiktok_session_id
        if config.tiktok_target_idc:
            cookies["tt-target-idc"] = config.tiktok_target_idc

    try:
        url = f"https://www.tiktok.com/@{clean_user}"
        with httpx.Client(
            headers=DEFAULT_HEADERS,
            cookies=cookies,
            proxy=config.tiktok_web_proxy,
            follow_redirects=True,
            timeout=8.0,
        ) as client:
            resp = client.get(url)
            if resp.status_code == 200:
                match = re.search(
                    r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>',
                    resp.text,
                    re.DOTALL,
                )
                if match:
                    data = json.loads(match.group(1))
                    user_detail = (
                        data.get("__DEFAULT_SCOPE__", {})
                        .get("webapp.user-detail", {})
                        .get("userInfo", {})
                    )
                    user_obj = user_detail.get("user", {})
                    stats_obj = user_detail.get("stats", {})

                    if user_obj:
                        result["display_name"] = user_obj.get("nickname") or clean_user
                        result["avatar_url"] = (
                            user_obj.get("avatarLarger")
                            or user_obj.get("avatarMedium")
                            or user_obj.get("avatarThumb")
                            or ""
                        )
                        room_id = str(user_obj.get("roomId") or "")
                        result["room_id"] = room_id if room_id and room_id != "0" else ""
                        result["is_live"] = bool(result["room_id"])
                    if stats_obj:
                        result["follower_count"] = int(
                            stats_obj.get("followerCount") or 0
                        )
    except Exception as exc:
        logger.debug("TikTok Profil-Abfrage Fallback für %s: %s", clean_user, exc)

    return result


@dataclass
class PendingStreak:
    """Zwischenspeicher für laufende Combo-/Streak-Geschenke (falls repeat_end wegen Disconnect ausbleibt)."""
    streamer_id: int
    session_id: Optional[int]
    sender_user_id: str
    sender_username: str
    sender_nickname: str
    is_super_fan: bool
    gift_id: int
    gift_name: str
    gift_icon_url: str
    diamond_count: int
    repeat_count: int
    combo_count: int
    group_id: str
    room_fan_tickets: int
    event_uid: str
    updated_at: float = field(default_factory=time.monotonic)


@dataclass
class WorkerDiagnostics:
    """Laufzeit-Telemetrie pro überwachtem Streamer."""
    streamer_id: int
    username: str
    state: str = "stopped"
    auto_reconnect: bool = True
    authenticated_session: bool = False
    room_id: str = ""
    session_id: Optional[int] = None
    connected_since: Optional[str] = None
    last_event_at: Optional[str] = None
    last_message: str = "Bereit"
    last_error: str = ""
    current_viewers: int = 0
    peak_viewers: int = 0
    room_fan_tickets: int = 0
    reconnect_attempts: int = 0
    gifts_received_session: int = 0
    coins_received_session: int = 0


_known_donor_tiers_cache: Dict[str, str] = {}
_known_donor_tiers_lock = threading.Lock()
_last_donor_cache_refresh = 0.0


def get_cached_donor_tier(username: str) -> str:
    global _last_donor_cache_refresh
    clean = username.strip().lstrip("@").lower()
    now = time.monotonic()
    if now - _last_donor_cache_refresh > 180.0:
        refresh_donor_tier_cache()
    with _known_donor_tiers_lock:
        return _known_donor_tiers_cache.get(clean, "")


def update_cached_donor_tier(username: str, tier: str) -> None:
    if not tier:
        return
    clean = username.strip().lstrip("@").lower()
    with _known_donor_tiers_lock:
        _known_donor_tiers_cache[clean] = tier


def refresh_donor_tier_cache() -> None:
    global _last_donor_cache_refresh
    try:
        tiers = get_known_donor_tiers()
        with _known_donor_tiers_lock:
            _known_donor_tiers_cache.clear()
            _known_donor_tiers_cache.update(tiers)
        _last_donor_cache_refresh = time.monotonic()
    except Exception as exc:
        logger.debug("Fehler beim Aktualisieren des Spender-Tier-Caches: %s", exc)


class StreamerWorker:
    STREAK_TIMEOUT_SECONDS = 12.0

    def __init__(
        self,
        streamer_id: int,
        username: str,
        auto_reconnect: bool = True,
    ) -> None:
        self.streamer_id = streamer_id
        self.username = username.strip().lstrip("@").lower()
        self.diag = WorkerDiagnostics(
            streamer_id=streamer_id,
            username=self.username,
            auto_reconnect=auto_reconnect,
            authenticated_session=config.has_tiktok_session,
        )
        self._stop_event = threading.Event()
        self._preserve_db_state = False
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._client: Optional[Any] = None
        self._gift_catalog_cache: Dict[int, Tuple[str, int, str]] = {}
        self._pending_streaks: Dict[str, PendingStreak] = {}
        self._active_battle: Optional[Dict[str, Any]] = None
        self._recent_logs: Deque[Dict[str, str]] = deque(maxlen=50)
        self._chat_buffer: List[Dict[str, Any]] = []
        self._chat_buffer_lock = threading.Lock()
        self._last_viewer_db_update = 0.0
        self._last_saved_viewers = 0

    def _log(self, level: str, message: str) -> None:
        ts = datetime.now().isoformat(timespec="seconds")
        with self._lock:
            self.diag.last_message = message
            self._recent_logs.appendleft(
                {"timestamp": ts, "level": level, "message": message}
            )
        if level == "ERROR":
            logger.error("[@%s] %s", self.username, message)
        else:
            logger.info("[@%s] %s", self.username, message)

    def is_alive(self) -> bool:
        return bool(self._thread and self._thread.is_alive() and not self._stop_event.is_set())

    def get_snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "streamer_id": self.diag.streamer_id,
                "username": self.diag.username,
                "is_running": self.is_alive(),
                "state": self.diag.state,
                "auto_reconnect": self.diag.auto_reconnect,
                "authenticated_session": self.diag.authenticated_session,
                "room_id": self.diag.room_id,
                "session_id": self.diag.session_id,
                "connected_since": self.diag.connected_since,
                "last_event_at": self.diag.last_event_at,
                "last_message": self.diag.last_message,
                "last_error": self.diag.last_error,
                "current_viewers": self.diag.current_viewers,
                "peak_viewers": self.diag.peak_viewers,
                "room_fan_tickets": self.diag.room_fan_tickets,
                "reconnect_attempts": self.diag.reconnect_attempts,
                "gifts_received_session": self.diag.gifts_received_session,
                "coins_received_session": self.diag.coins_received_session,
                "active_battle": dict(self._active_battle) if self._active_battle else None,
                "pending_streaks_count": len(self._pending_streaks),
                "logs": list(self._recent_logs)[:15],
            }

    def start(self, auto_reconnect: Optional[bool] = None) -> None:
        with self._lock:
            if auto_reconnect is not None:
                self.diag.auto_reconnect = auto_reconnect
            if self.is_alive():
                return
            self._preserve_db_state = False
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._thread_main,
                name=f"TikTokWorker-{self.username}",
                daemon=True,
            )
            self._thread.start()

    def stop(self, preserve_db_state: bool = False) -> None:
        """
        Stoppt den Worker.
        - `preserve_db_state=False` (Manueller Stop durch Nutzer): Deaktiviert `is_tracking` und `auto_monitor` in der DB.
        - `preserve_db_state=True` (Server-Shutdown / Restart): Lässt `auto_monitor` und `is_tracking` in der DB unverändert,
          damit der Streamer beim nächsten Programmstart automatisch wieder aufgezeichnet wird.
        """
        with self._lock:
            self._preserve_db_state = preserve_db_state
            self._stop_event.set()
            self.diag.state = "stopped"
            client = self._client
            loop = self._loop

        if client is not None and loop is not None and loop.is_running():
            try:
                asyncio.run_coroutine_threadsafe(client.disconnect(), loop)
            except Exception as exc:
                logger.debug("Disconnect-Signal Fehler für @%s: %s", self.username, exc)

        self._finish_active_battle_if_any()
        self._flush_all_pending_streaks()
        self._flush_chat_buffer()
        if self.diag.session_id:
            end_stream_session(self.streamer_id, self.diag.session_id)
            self.diag.session_id = None

        if preserve_db_state:
            update_streamer_runtime_state(
                self.username,
                is_live=False,
                current_viewers=0,
            )
            self._log("INFO", "Worker für Server-Stopp angehalten (Auto-Start bleibt in DB aktiv).")
        else:
            update_streamer_runtime_state(
                self.username,
                is_live=False,
                is_tracking=False,
                auto_monitor=False,
                current_viewers=0,
            )
            self._log("INFO", "Worker manuell gestoppt (Auto-Start deaktiviert).")

    def _thread_main(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        with self._lock:
            self._loop = loop

        try:
            loop.run_until_complete(self._supervisor_loop())
        except Exception as exc:
            self._log("ERROR", f"Unerwarteter Worker-Abbruch: {exc}")
        finally:
            self._finish_active_battle_if_any()
            self._flush_all_pending_streaks()
            self._flush_chat_buffer()
            if self.diag.session_id:
                end_stream_session(self.streamer_id, self.diag.session_id)
                self.diag.session_id = None

            if self._preserve_db_state:
                update_streamer_runtime_state(
                    self.username,
                    is_live=False,
                    current_viewers=0,
                )
            else:
                update_streamer_runtime_state(
                    self.username,
                    is_live=False,
                    is_tracking=False if not self.diag.auto_reconnect else None,
                    current_viewers=0,
                )
            with self._lock:
                self._client = None
                self._loop = None
                if self.diag.state != "stopped":
                    self.diag.state = "stopped"
            try:
                loop.close()
            except Exception:
                pass

    def _create_configured_client(self) -> Any:
        """
        Erstellt eine TikTokLiveClient-Instanz und injiziert Session-Cookies
        (`sessionid` + `tt-target-idc`) sowie optionale Proxies aus der .env / Umgebung.
        Unterdrückt außerdem bekannte Protobuf-Schema-Fehler für nicht genutzte
        TikTok-Nachrichten (wie WebcastLinkLayerMessage / HashtagNamespace).
        """
        web_proxy = httpx.Proxy(config.tiktok_web_proxy) if config.tiktok_web_proxy else None
        client = TikTokLiveClient(
            unique_id=f"@{self.username}",
            web_proxy=web_proxy,
        )
        # Verhindert laute Stacktraces bei kaputten/unbekannten TikTok-Protobuf-Payloads
        client.ignore_broken_payload = True
        if hasattr(client, "parse_error_ignorelist") and isinstance(client.parse_error_ignorelist, list):
            for pat in ("HashtagNamespace", "WebcastLinkLayerMessage"):
                if pat not in client.parse_error_ignorelist:
                    client.parse_error_ignorelist.append(pat)

        if config.has_tiktok_session:
            client.web.set_session(
                session_id=config.tiktok_session_id,
                tt_target_idc=config.tiktok_target_idc or "eu-ttp2",
            )
            with self._lock:
                self.diag.authenticated_session = True
        return client

    async def _start_client_with_age_bypass(self, client: Any) -> Any:
        """
        Startet die TikTokLive-Verbindung.
        - Ohne hinterlegte `TIKTOK_SESSION_ID` wird `fetch_room_info=False` genutzt, da
          TikTokLive v7.0.1 bei altersbeschränkten (18+) Streams sonst einen `AgeRestrictedError`
          wirft, obwohl der WebSocket-Stream über den Sign-Server trotzdem empfangen werden kann!
        - Falls trotz Session ein `AgeRestrictedError` beim Abrufen der Room-Info auftritt,
          fällt der Worker automatisch auf `fetch_room_info=False` zurück.
        """
        use_room_info = bool(config.has_tiktok_session)
        try:
            return await client.start(
                process_connect_events=True,
                compress_ws_events=True,
                fetch_room_info=use_room_info,
                fetch_gift_info=True,
                fetch_live_check=True,
            )
        except AgeRestrictedError:
            self._log(
                "INFO",
                "18+ Stream erkannt (AgeRestrictedError bei Room-Info) -> Verbinde im Bypass-Modus (fetch_room_info=False)...",
            )
            resolved_room_id = getattr(client, "_room_id", None) or None
            return await client.start(
                process_connect_events=True,
                compress_ws_events=True,
                fetch_room_info=False,
                fetch_gift_info=False,
                fetch_live_check=False,
                room_id=int(resolved_room_id) if resolved_room_id else None,
            )

    async def _supervisor_loop(self) -> None:
        backoff = 5.0

        while not self._stop_event.is_set():
            with self._lock:
                self.diag.state = "connecting"

            auth_hint = " (mit Session-Cookie)" if config.has_tiktok_session else " (anonym / 18+ Bypass aktiv)"
            self._log("INFO", f"Prüfe Live-Status & verbinde mit TikTok Webcast{auth_hint}...")

            update_streamer_runtime_state(
                self.username,
                is_tracking=True,
                auto_monitor=self.diag.auto_reconnect,
            )

            client = self._create_configured_client()
            with self._lock:
                self._client = client

            self._register_handlers(client)

            try:
                ws_task = await self._start_client_with_age_bypass(client)
                backoff = 5.0
                self.diag.reconnect_attempts = 0

                streak_watchdog = asyncio.create_task(self._streak_watchdog_loop())
                try:
                    await ws_task
                finally:
                    streak_watchdog.cancel()
                    self._flush_all_pending_streaks()

            except Exception as exc:
                if is_streamer_offline_error(exc):
                    with self._lock:
                        self.diag.state = "polling_offline"
                        self.diag.current_viewers = 0
                        self.diag.last_error = ""
                    if self.diag.session_id:
                        end_stream_session(self.streamer_id, self.diag.session_id)
                        self.diag.session_id = None

                    update_streamer_runtime_state(
                        self.username,
                        is_live=False,
                        is_tracking=self.diag.auto_reconnect,
                        current_viewers=0,
                        last_error="",
                    )

                    if not self.diag.auto_reconnect or self._stop_event.is_set():
                        self._log("INFO", "Streamer ist offline (Einmal-Check beendet).")
                        break

                    poll_sec = max(15, int(get_settings().get("poll_interval_seconds", 45)))
                    self._log(
                        "INFO",
                        f"Streamer aktuell offline – nächster Live-Check in {poll_sec}s.",
                    )
                    await self._interruptible_sleep(float(poll_sec))
                    continue

            except Exception as exc:
                err_name = type(exc).__name__
                err_text = f"{err_name}: {exc}"
                with self._lock:
                    self.diag.last_error = err_text
                    self.diag.reconnect_attempts += 1
                    self.diag.state = "backoff" if self.diag.auto_reconnect else "error"

                self._log("ERROR", f"Webcast-Fehler ({err_name}): {exc}")
                update_streamer_runtime_state(
                    self.username,
                    is_live=False,
                    current_viewers=0,
                    last_error=err_text[:240],
                )

                if not self.diag.auto_reconnect or self._stop_event.is_set():
                    break

                wait_s = min(120.0, backoff)
                self._log("INFO", f"Reconnect-Versuch in {int(wait_s)}s...")
                await self._interruptible_sleep(wait_s)
                backoff = min(120.0, backoff * 1.8)
                continue

            finally:
                try:
                    if getattr(client, "connected", False):
                        await client.disconnect(close_client=True)
                    else:
                        await client.close()
                except Exception:
                    pass
                with self._lock:
                    self._client = None

            if not self.diag.auto_reconnect or self._stop_event.is_set():
                break

            poll_sec = max(15, int(get_settings().get("poll_interval_seconds", 45)))
            await self._interruptible_sleep(float(poll_sec))

    async def _interruptible_sleep(self, seconds: float) -> None:
        end_time = time.monotonic() + seconds
        while not self._stop_event.is_set() and time.monotonic() < end_time:
            await asyncio.sleep(min(0.5, end_time - time.monotonic()))

    async def _streak_watchdog_loop(self) -> None:
        while not self._stop_event.is_set():
            await asyncio.sleep(2.0)
            self._flush_expired_streaks()
            self._flush_chat_buffer()

    def _persist_viewer_stats(self, viewers: int, session_id: Optional[int]) -> None:
        try:
            update_streamer_runtime_state(self.username, current_viewers=viewers)
            if session_id:
                update_stream_session_metrics(session_id, viewer_count=viewers)
        except Exception as exc:
            logger.debug("[@%s] Fehler beim Persistieren der Zuschauerzahlen: %s", self.username, exc)

    def _register_handlers(self, client: Any) -> None:
        @client.on(ConnectEvent)
        async def on_connect(event: ConnectEvent) -> None:
            room_id = str(getattr(client, "room_id", "") or "")
            room_info = getattr(client, "room_info", None) or {}
            gift_info = getattr(client, "gift_info", None)

            self._cache_gift_catalog(gift_info)

            title = ""
            display_name = None
            avatar_url = None
            if isinstance(room_info, dict):
                title = str(room_info.get("title") or "")
                owner = room_info.get("owner") or {}
                if isinstance(owner, dict):
                    display_name = owner.get("nickname")
                    avatar_thumb = owner.get("avatar_thumb") or {}
                    if isinstance(avatar_thumb, dict):
                        urls = avatar_thumb.get("url_list") or []
                        if urls:
                            avatar_url = urls[0]

            session_id = start_stream_session(
                streamer_id=self.streamer_id,
                room_id=room_id,
                title=title,
            )

            now_iso = datetime.now().isoformat(timespec="seconds")
            with self._lock:
                self.diag.state = "connected"
                self.diag.room_id = room_id
                self.diag.session_id = session_id
                self.diag.connected_since = now_iso
                self.diag.last_event_at = now_iso
                self.diag.last_error = ""
                self.diag.gifts_received_session = 0
                self.diag.coins_received_session = 0

            update_streamer_runtime_state(
                self.username,
                is_live=True,
                is_tracking=True,
                room_id=room_id,
                display_name=display_name,
                avatar_url=avatar_url,
                last_error="",
            )
            self._log("INFO", f"Verbunden mit Live-Stream (Room {room_id}, Session #{session_id}).")

        @client.on(RoomUserSeqEvent)
        async def on_room_user_seq(event: RoomUserSeqEvent) -> None:
            viewers = int(getattr(event, "total", 0) or 0)
            now_iso = datetime.now().isoformat(timespec="seconds")
            with self._lock:
                self.diag.current_viewers = viewers
                is_new_peak = viewers > self.diag.peak_viewers
                self.diag.peak_viewers = max(self.diag.peak_viewers, viewers)
                self.diag.last_event_at = now_iso
                sess_id = self.diag.session_id

            now_mono = time.monotonic()
            should_update_db = (
                (now_mono - self._last_viewer_db_update >= 25.0) or
                is_new_peak or
                (abs(viewers - self._last_saved_viewers) >= 50)
            )
            if should_update_db:
                self._last_viewer_db_update = now_mono
                self._last_saved_viewers = viewers
                await asyncio.to_thread(self._persist_viewer_stats, viewers, sess_id)

        @client.on(LiveEndEvent)
        async def on_live_end(event: LiveEndEvent) -> None:
            self._finish_active_battle_if_any()
            self._flush_all_pending_streaks()
            self._flush_chat_buffer()
            with self._lock:
                sess_id = self.diag.session_id
                self.diag.session_id = None
                self.diag.current_viewers = 0
            if sess_id:
                end_stream_session(self.streamer_id, sess_id)
            update_streamer_runtime_state(
                self.username, is_live=False, current_viewers=0
            )
            self._log("INFO", "Streamer hat den Live-Stream beendet (LiveEndEvent).")

        @client.on(DisconnectEvent)
        async def on_disconnect(event: DisconnectEvent) -> None:
            self._finish_active_battle_if_any()
            self._flush_all_pending_streaks()
            self._flush_chat_buffer()
            with self._lock:
                self.diag.current_viewers = 0
            update_streamer_runtime_state(
                self.username, is_live=False, current_viewers=0
            )
            self._log("INFO", "WebSocket-Verbindung getrennt.")

        @client.on(GiftEvent)
        async def on_gift(event: GiftEvent) -> None:
            try:
                self._process_gift_event(event)
            except Exception as exc:
                self._log("ERROR", f"Fehler bei GiftEvent-Verarbeitung: {exc}")

        if TIKTOKLIVE_AVAILABLE and CommentEvent is not None:
            @client.on(CommentEvent)
            async def on_comment(event: CommentEvent) -> None:
                try:
                    self._process_comment_event(event)
                except Exception:
                    pass


        if TIKTOKLIVE_AVAILABLE and LinkMicBattleEvent is not None:
            @client.on(LinkMicBattleEvent)
            async def on_battle(event: LinkMicBattleEvent) -> None:
                try:
                    self._handle_battle_event(event)
                except Exception as exc:
                    self._log("ERROR", f"Fehler bei LinkMicBattleEvent-Verarbeitung: {exc}")

        if TIKTOKLIVE_AVAILABLE and LinkMicArmiesEvent is not None:
            @client.on(LinkMicArmiesEvent)
            async def on_armies(event: LinkMicArmiesEvent) -> None:
                try:
                    self._handle_armies_event(event)
                except Exception as exc:
                    self._log("ERROR", f"Fehler bei LinkMicArmiesEvent-Verarbeitung: {exc}")

    def _extract_battle_matchup(self, event: Any = None, anchors_info: Any = None) -> Dict[str, Any]:
        """
        Extrahiert vollständige Kontrahenten- und Teaminformationen aus anchors_info,
        team_member und team_armies für 1v1, 2v2, 1v1v1 (3er) und 1v1v1v1 (4er-Einzel).
        """
        matchup = {
            "battle_mode": "1v1",
            "opponent_username": "",
            "opponent_display_name": "",
            "opponent_avatar_url": "",
            "opponent_user_id": "",
            "teammate_username": "",
            "teammate_display_name": "",
            "teammate_avatar_url": "",
            "teammate_user_id": "",
            "opponent2_username": "",
            "opponent2_display_name": "",
            "opponent2_avatar_url": "",
            "opponent2_user_id": "",
            "opponent3_username": "",
            "opponent3_display_name": "",
            "opponent3_avatar_url": "",
            "opponent3_user_id": "",
        }

        anchors_raw = anchors_info or getattr(event, "anchors_info", None)
        if not anchors_raw:
            return matchup

        items = anchors_raw.values() if isinstance(anchors_raw, dict) else anchors_raw
        anchor_list = []
        anchor_map_by_id = {}
        clean_my_user = self.username.lower().lstrip("@")

        for item in items:
            val = getattr(item, "value", None) or item
            user = getattr(val, "user", None)
            if not user:
                continue

            u_id = str(getattr(user, "user_id", "") or "")
            display_id = str(getattr(user, "display_id", "") or "").lstrip("@")
            nick_name = str(getattr(user, "nick_name", "") or "")
            avatar_thumb = getattr(user, "avatar_thumb", None)
            avatar_url = ""
            if avatar_thumb:
                urls = getattr(avatar_thumb, "url_list", None) or []
                if urls:
                    avatar_url = str(urls[0])

            p_data = {
                "user_id": u_id,
                "username": display_id,
                "display_name": nick_name or display_id,
                "avatar_url": avatar_url,
            }
            anchor_list.append(p_data)
            if u_id:
                anchor_map_by_id[u_id] = p_data

        if not anchor_list:
            return matchup

        # 1. Fall: Genau 3 Teilnehmer -> Immer 3er-Match / Jeder-gegen-Jeden (1v1v1)
        if len(anchor_list) == 3:
            matchup["battle_mode"] = "1v1v1"
            my_streamers = [a for a in anchor_list if a["username"].lower() == clean_my_user]
            opponents = [a for a in anchor_list if a["username"].lower() != clean_my_user]
            if not opponents and len(anchor_list) >= 3:
                opponents = anchor_list[1:]

            if len(opponents) > 0:
                opp1 = opponents[0]
                matchup["opponent_user_id"] = opp1["user_id"]
                matchup["opponent_username"] = opp1["username"]
                matchup["opponent_display_name"] = opp1["display_name"]
                matchup["opponent_avatar_url"] = opp1["avatar_url"]
            if len(opponents) > 1:
                opp2 = opponents[1]
                matchup["opponent2_user_id"] = opp2["user_id"]
                matchup["opponent2_username"] = opp2["username"]
                matchup["opponent2_display_name"] = opp2["display_name"]
                matchup["opponent2_avatar_url"] = opp2["avatar_url"]
            return matchup

        # 2. Fall: 4 Teilnehmer -> Prüfen ob 2v2 Team-Battle oder 1v1v1v1 (4er-Einzel / FFA)
        team_members = getattr(event, "team_member", None) if event else None
        team_armies = getattr(event, "team_armies", None) if event else None

        # Prüfen ob echte 2er-Teams vorliegen (in 2v2 hat jedes Team 2 Spieler)
        has_2v2_teams = False
        if team_members and len(team_members) == 2:
            team_lens = [len(getattr(t, "user_id", None) or []) for t in team_members]
            if all(tl >= 2 for tl in team_lens):
                has_2v2_teams = True
        elif team_armies and len(team_armies) == 2:
            team_lens = [len(getattr(ta, "team_user", None) or []) for ta in team_armies]
            if all(tl >= 2 for tl in team_lens):
                has_2v2_teams = True

        if len(anchor_list) >= 4 and not has_2v2_teams:
            # 4er-Einzelmatch (1v1v1v1 / Free-For-All)
            matchup["battle_mode"] = "1v1v1v1"
            opponents = [a for a in anchor_list if a["username"].lower() != clean_my_user]
            if len(opponents) < 3 and len(anchor_list) >= 4:
                opponents = anchor_list[1:4]

            if len(opponents) > 0:
                opp1 = opponents[0]
                matchup["opponent_user_id"] = opp1["user_id"]
                matchup["opponent_username"] = opp1["username"]
                matchup["opponent_display_name"] = opp1["display_name"]
                matchup["opponent_avatar_url"] = opp1["avatar_url"]
            if len(opponents) > 1:
                opp2 = opponents[1]
                matchup["opponent2_user_id"] = opp2["user_id"]
                matchup["opponent2_username"] = opp2["username"]
                matchup["opponent2_display_name"] = opp2["display_name"]
                matchup["opponent2_avatar_url"] = opp2["avatar_url"]
            if len(opponents) > 2:
                opp3 = opponents[2]
                matchup["opponent3_user_id"] = opp3["user_id"]
                matchup["opponent3_username"] = opp3["username"]
                matchup["opponent3_display_name"] = opp3["display_name"]
                matchup["opponent3_avatar_url"] = opp3["avatar_url"]
            return matchup

        # 3. Fall: 2v2 Team Match
        my_team = []
        opp_team = []

        if team_members:
            for team in team_members:
                t_uids = [str(u) for u in (getattr(team, "user_id", None) or [])]
                is_my_team = any(
                    (uid in anchor_map_by_id and anchor_map_by_id[uid]["username"].lower() == clean_my_user)
                    for uid in t_uids
                )
                if is_my_team:
                    my_team = [anchor_map_by_id[uid] for uid in t_uids if uid in anchor_map_by_id]
                else:
                    opp_team.extend([anchor_map_by_id[uid] for uid in t_uids if uid in anchor_map_by_id])

        if (not my_team or not opp_team) and team_armies:
            for t_army in team_armies:
                t_users = getattr(t_army, "team_user", None) or []
                t_uids = [str(getattr(tu, "user_id", "") or "") for tu in t_users]
                is_my_team = any(
                    (uid in anchor_map_by_id and anchor_map_by_id[uid]["username"].lower() == clean_my_user)
                    for uid in t_uids
                )
                if is_my_team:
                    my_team = [anchor_map_by_id[uid] for uid in t_uids if uid in anchor_map_by_id]
                else:
                    opp_team.extend([anchor_map_by_id[uid] for uid in t_uids if uid in anchor_map_by_id])

        if not my_team and len(anchor_list) >= 4:
            my_idx = 0
            for idx, a in enumerate(anchor_list):
                if a["username"].lower() == clean_my_user:
                    my_idx = idx
                    break
            if my_idx < 2:
                my_team = anchor_list[:2]
                opp_team = anchor_list[2:4]
            else:
                my_team = anchor_list[2:4]
                opp_team = anchor_list[:2]

        if not my_team:
            my_team = [a for a in anchor_list if a["username"].lower() == clean_my_user] or [anchor_list[0]]
            opp_team = [a for a in anchor_list if a["username"].lower() != clean_my_user]

        teammate = None
        for a in my_team:
            if a["username"].lower() != clean_my_user:
                teammate = a
                break

        opp1 = opp_team[0] if len(opp_team) > 0 else None
        opp2 = opp_team[1] if len(opp_team) > 1 else None

        is_2v2 = bool(teammate or opp2 or len(anchor_list) >= 4)
        matchup["battle_mode"] = "2v2" if is_2v2 else "1v1"

        if opp1:
            matchup["opponent_user_id"] = opp1["user_id"]
            matchup["opponent_username"] = opp1["username"]
            matchup["opponent_display_name"] = opp1["display_name"]
            matchup["opponent_avatar_url"] = opp1["avatar_url"]

        if teammate:
            matchup["teammate_user_id"] = teammate["user_id"]
            matchup["teammate_username"] = teammate["username"]
            matchup["teammate_display_name"] = teammate["display_name"]
            matchup["teammate_avatar_url"] = teammate["avatar_url"]

        if opp2:
            matchup["opponent2_user_id"] = opp2["user_id"]
            matchup["opponent2_username"] = opp2["username"]
            matchup["opponent2_display_name"] = opp2["display_name"]
            matchup["opponent2_avatar_url"] = opp2["avatar_url"]

        return matchup

    def _extract_opponent_info(self, anchors_info: Any) -> Dict[str, Any]:
        matchup = self._extract_battle_matchup(anchors_info=anchors_info)
        return {
            "user_id": matchup["opponent_user_id"],
            "username": matchup["opponent_username"],
            "display_name": matchup["opponent_display_name"],
            "avatar_url": matchup["opponent_avatar_url"],
        }

    def _extract_armies_and_mvps(
        self,
        armies: Any,
        matchup: Optional[Dict[str, Any]] = None,
        opponent_user_id: str = "",
    ) -> Dict[str, Any]:
        """
        Extrahiert Punktestände und die Top-Spender (MVPs) aus der Armies-Struktur.
        Unterstützt 1v1, 2v2, 1v1v1 (3er) sowie 1v1v1v1 (4er-Einzel).
        """
        data = {
            "streamer_score": 0,
            "opponent_score": 0,
            "teammate_score": 0,
            "opponent2_score": 0,
            "opponent3_score": 0,
            "streamer_mvp_name": "",
            "streamer_mvp_score": 0,
            "streamer_mvp_avatar": "",
            "opponent_mvp_name": "",
            "opponent_mvp_score": 0,
            "opponent_mvp_avatar": "",
        }
        if not armies:
            return data

        try:
            if isinstance(armies, dict):
                items = list(armies.values())
            elif isinstance(armies, (list, tuple)):
                items = list(armies)
            else:
                items = [armies]

            streamer_uid = str((matchup or {}).get("streamer_user_id", "") or "")
            teammate_uid = str((matchup or {}).get("teammate_user_id", "") or "")
            opp1_uid = str((matchup or {}).get("opponent_user_id", "") or opponent_user_id or "")
            opp2_uid = str((matchup or {}).get("opponent2_user_id", "") or "")
            opp3_uid = str((matchup or {}).get("opponent3_user_id", "") or "")
            b_mode = str((matchup or {}).get("battle_mode", "1v1") or "1v1")

            for idx, item in enumerate(items):
                val = getattr(item, "value", None) or item
                hostscore = int(getattr(val, "hostscore", 0) or getattr(val, "team_total_score", 0) or 0)
                anchor_id = str(getattr(val, "anchor_id_str", "") or getattr(item, "key", "") or "")

                user_armies_raw = getattr(val, "user_armies", None)
                if hasattr(user_armies_raw, "user_armies"):
                    user_armies_raw = getattr(user_armies_raw, "user_armies", None)

                if isinstance(user_armies_raw, dict):
                    user_list = list(user_armies_raw.values())
                elif isinstance(user_armies_raw, (list, tuple)):
                    user_list = list(user_armies_raw)
                elif user_armies_raw is not None and not hasattr(user_armies_raw, "__iter__"):
                    user_list = [user_armies_raw]
                else:
                    user_list = []

                mvp_name = ""
                mvp_score = 0
                mvp_avatar = ""
                if user_list:
                    top_u = user_list[0]
                    mvp_name = str(getattr(top_u, "nickname", "") or getattr(top_u, "display_id", "") or "")
                    mvp_score = int(getattr(top_u, "score", 0) or getattr(top_u, "diamond_score", 0) or 0)
                    av_thumb = getattr(top_u, "avatar_thumb", None)
                    if av_thumb:
                        urls = getattr(av_thumb, "url_list", None) or []
                        if urls:
                            mvp_avatar = str(urls[0])

                # Einzelpunkte aus team_user (2v2 Team-Battle)
                team_users = getattr(val, "team_user", None) or []
                team_user_uids = []
                for tu in team_users:
                    tu_uid = str(getattr(tu, "user_id", "") or "")
                    tu_score = int(getattr(tu, "score", 0) or 0)
                    team_user_uids.append(tu_uid)
                    if tu_uid and tu_uid == teammate_uid:
                        data["teammate_score"] = tu_score
                    elif tu_uid and tu_uid == opp2_uid:
                        data["opponent2_score"] = tu_score

                # Zuordnung nach Modus
                if b_mode in ("1v1v1", "1v1v1v1"):
                    # Free-for-all: direkte Zuweisung nach anchor_id oder Reihenfolge
                    if streamer_uid and anchor_id == streamer_uid:
                        data["streamer_score"] = hostscore
                        if mvp_name:
                            data["streamer_mvp_name"] = mvp_name
                            data["streamer_mvp_score"] = mvp_score
                            data["streamer_mvp_avatar"] = mvp_avatar
                    elif opp1_uid and anchor_id == opp1_uid:
                        data["opponent_score"] = hostscore
                        if mvp_name:
                            data["opponent_mvp_name"] = mvp_name
                            data["opponent_mvp_score"] = mvp_score
                            data["opponent_mvp_avatar"] = mvp_avatar
                    elif opp2_uid and anchor_id == opp2_uid:
                        data["opponent2_score"] = hostscore
                    elif opp3_uid and anchor_id == opp3_uid:
                        data["opponent3_score"] = hostscore
                    else:
                        # Fallback nach Index
                        if idx == 0:
                            data["streamer_score"] = hostscore
                            if mvp_name:
                                data["streamer_mvp_name"] = mvp_name
                                data["streamer_mvp_score"] = mvp_score
                                data["streamer_mvp_avatar"] = mvp_avatar
                        elif idx == 1:
                            data["opponent_score"] = hostscore
                            if mvp_name:
                                data["opponent_mvp_name"] = mvp_name
                                data["opponent_mvp_score"] = mvp_score
                                data["opponent_mvp_avatar"] = mvp_avatar
                        elif idx == 2:
                            data["opponent2_score"] = hostscore
                        elif idx == 3:
                            data["opponent3_score"] = hostscore
                else:
                    # 1v1 oder 2v2
                    is_streamer_side = False
                    if streamer_uid and (anchor_id == streamer_uid or streamer_uid in team_user_uids):
                        is_streamer_side = True
                    elif teammate_uid and (anchor_id == teammate_uid or teammate_uid in team_user_uids):
                        is_streamer_side = True
                    elif opp1_uid and (anchor_id == opp1_uid or opp1_uid in team_user_uids):
                        is_streamer_side = False
                    elif opp2_uid and (anchor_id == opp2_uid or opp2_uid in team_user_uids):
                        is_streamer_side = False
                    elif idx == 0:
                        is_streamer_side = True
                    else:
                        is_streamer_side = False

                    if is_streamer_side:
                        data["streamer_score"] = hostscore
                        if mvp_name:
                            data["streamer_mvp_name"] = mvp_name
                            data["streamer_mvp_score"] = mvp_score
                            data["streamer_mvp_avatar"] = mvp_avatar
                    else:
                        data["opponent_score"] = hostscore
                        if mvp_name:
                            data["opponent_mvp_name"] = mvp_name
                            data["opponent_mvp_score"] = mvp_score
                            data["opponent_mvp_avatar"] = mvp_avatar
        except Exception as exc:
            logger.debug(f"_extract_armies_and_mvps Parsing-Fehler: {exc}")

        return data

    def _handle_battle_event(self, event: Any) -> None:
        """
        Verarbeitet LinkMicBattleEvents (Start, Ende, Abbruch und Updates).
        """
        action_val = getattr(event, "action", None)
        try:
            action_int = int(action_val) if action_val is not None else 0
        except Exception:
            action_int = 0
        action_str = str(action_val or "").upper()

        battle_id = str(getattr(event, "battle_id", "") or "")
        if not battle_id:
            settings = getattr(event, "battle_settings", None)
            if settings:
                battle_id = str(getattr(settings, "battle_id", "") or "")

        anchors_info = getattr(event, "anchors_info", None)
        armies = getattr(event, "armies", None) or getattr(event, "team_armies", None)

        # ACTION 4 = OPEN (Duell beginnt)
        if action_int == 4 or "OPEN" in action_str:
            matchup = self._extract_battle_matchup(event, anchors_info)
            duration = 300
            b_settings = getattr(event, "battle_settings", None)
            if b_settings:
                duration = int(getattr(b_settings, "duration", 300) or 300)

            db_id = record_battle_start(
                streamer_id=self.streamer_id,
                battle_id=battle_id or str(int(time.time())),
                opponent_username=matchup["opponent_username"],
                opponent_display_name=matchup["opponent_display_name"],
                opponent_avatar_url=matchup["opponent_avatar_url"],
                opponent_user_id=matchup["opponent_user_id"],
                session_id=self.diag.session_id,
                duration_seconds=duration,
                battle_mode=matchup["battle_mode"],
                teammate_user_id=matchup["teammate_user_id"],
                teammate_username=matchup["teammate_username"],
                teammate_display_name=matchup["teammate_display_name"],
                teammate_avatar_url=matchup["teammate_avatar_url"],
                opponent2_user_id=matchup["opponent2_user_id"],
                opponent2_username=matchup["opponent2_username"],
                opponent2_display_name=matchup["opponent2_display_name"],
                opponent2_avatar_url=matchup["opponent2_avatar_url"],
                opponent3_user_id=matchup.get("opponent3_user_id", ""),
                opponent3_username=matchup.get("opponent3_username", ""),
                opponent3_display_name=matchup.get("opponent3_display_name", ""),
                opponent3_avatar_url=matchup.get("opponent3_avatar_url", ""),
            )

            with self._lock:
                self._active_battle = {
                    "db_id": db_id,
                    "battle_id": battle_id,
                    "battle_mode": matchup["battle_mode"],
                    "opponent_user_id": matchup["opponent_user_id"],
                    "opponent_username": matchup["opponent_username"],
                    "opponent_display_name": matchup["opponent_display_name"],
                    "opponent_avatar_url": matchup["opponent_avatar_url"],
                    "teammate_user_id": matchup["teammate_user_id"],
                    "teammate_username": matchup["teammate_username"],
                    "teammate_display_name": matchup["teammate_display_name"],
                    "teammate_avatar_url": matchup["teammate_avatar_url"],
                    "opponent2_user_id": matchup["opponent2_user_id"],
                    "opponent2_username": matchup["opponent2_username"],
                    "opponent2_display_name": matchup["opponent2_display_name"],
                    "opponent2_avatar_url": matchup["opponent2_avatar_url"],
                    "opponent3_user_id": matchup.get("opponent3_user_id", ""),
                    "opponent3_username": matchup.get("opponent3_username", ""),
                    "opponent3_display_name": matchup.get("opponent3_display_name", ""),
                    "opponent3_avatar_url": matchup.get("opponent3_avatar_url", ""),
                    "streamer_rank": 0,
                    "started_at": datetime.now().isoformat(timespec="seconds"),
                    "streamer_score": 0,
                    "opponent_score": 0,
                    "teammate_score": 0,
                    "opponent2_score": 0,
                    "opponent3_score": 0,
                    "streamer_mvp_name": "",
                    "streamer_mvp_score": 0,
                    "streamer_mvp_avatar": "",
                    "opponent_mvp_name": "",
                    "opponent_mvp_score": 0,
                    "opponent_mvp_avatar": "",
                    "coins_earned": 0,
                }

            if matchup["battle_mode"] == "2v2":
                mode_label = "2v2 (Team-Match)"
            elif matchup["battle_mode"] == "1v1v1":
                mode_label = "1v1v1 (3er-Match)"
            elif matchup["battle_mode"] == "1v1v1v1":
                mode_label = "1v1v1v1 (4er-Einzelmatch)"
            else:
                mode_label = "1v1 Duell"

            opp_parts = []
            if matchup.get("opponent_username"):
                opp_parts.append(f"@{matchup['opponent_username']}")
            if matchup.get("opponent2_username"):
                opp_parts.append(f"@{matchup['opponent2_username']}")
            if matchup.get("opponent3_username"):
                opp_parts.append(f"@{matchup['opponent3_username']}")
            opp_name_display = " & ".join(opp_parts) if opp_parts else "Gegner"
            team_str = f" mit @{matchup['teammate_username']}" if matchup.get("teammate_username") else ""
            self._log("INFO", f"⚔️ {mode_label} gestartet: @{self.username}{team_str} VS {opp_name_display} (Battle #{battle_id})")

        # ACTION 5 = FINISH oder ACTION 6 = CUT_SHORT (Duell beendet)
        elif action_int in (5, 6) or any(k in action_str for k in ("FINISH", "CUT_SHORT")):
            active = None
            with self._lock:
                active = self._active_battle

            army_data = self._extract_armies_and_mvps(armies, matchup=active)

            s_score = army_data["streamer_score"] or (active.get("streamer_score", 0) if active else 0)
            o_score = army_data["opponent_score"] or (active.get("opponent_score", 0) if active else 0)
            tm_score = army_data.get("teammate_score", 0) or (active.get("teammate_score", 0) if active else 0)
            op2_score = army_data.get("opponent2_score", 0) or (active.get("opponent2_score", 0) if active else 0)
            op3_score = army_data.get("opponent3_score", 0) or (active.get("opponent3_score", 0) if active else 0)

            b_mode = active.get("battle_mode", "1v1") if active else "1v1"
            computed_rank = 0

            if b_mode in ("1v1v1", "1v1v1v1"):
                # Platzierungs-Auswertung für FFA Modi
                scores = [("streamer", s_score), ("opp1", o_score), ("opp2", op2_score)]
                if b_mode == "1v1v1v1":
                    scores.append(("opp3", op3_score))
                scores_sorted = sorted(scores, key=lambda x: x[1], reverse=True)
                for idx, (who, _) in enumerate(scores_sorted):
                    if who == "streamer":
                        computed_rank = idx + 1
                        break
                if computed_rank == 1:
                    if len(scores_sorted) > 1 and scores_sorted[0][1] == scores_sorted[1][1] and scores_sorted[0][1] > 0:
                        result = "DRAW"
                    else:
                        result = "WIN"
                else:
                    result = "LOSE"
            else:
                if s_score > o_score:
                    result = "WIN"
                elif s_score < o_score:
                    result = "LOSE"
                elif s_score == o_score and (s_score > 0 or o_score > 0):
                    result = "DRAW"
                else:
                    result = "CANCELLED" if action_int == 6 else "DRAW"

            db_id = active.get("db_id") if active else None
            if not db_id:
                matchup = self._extract_battle_matchup(event, anchors_info)
                b_mode = matchup["battle_mode"]
                db_id = record_battle_start(
                    streamer_id=self.streamer_id,
                    battle_id=battle_id or str(int(time.time())),
                    opponent_username=matchup["opponent_username"],
                    opponent_display_name=matchup["opponent_display_name"],
                    opponent_avatar_url=matchup["opponent_avatar_url"],
                    opponent_user_id=matchup["opponent_user_id"],
                    session_id=self.diag.session_id,
                    battle_mode=matchup["battle_mode"],
                    teammate_user_id=matchup["teammate_user_id"],
                    teammate_username=matchup["teammate_username"],
                    teammate_display_name=matchup["teammate_display_name"],
                    teammate_avatar_url=matchup["teammate_avatar_url"],
                    opponent2_user_id=matchup["opponent2_user_id"],
                    opponent2_username=matchup["opponent2_username"],
                    opponent2_display_name=matchup["opponent2_display_name"],
                    opponent2_avatar_url=matchup["opponent2_avatar_url"],
                    opponent3_user_id=matchup.get("opponent3_user_id", ""),
                    opponent3_username=matchup.get("opponent3_username", ""),
                    opponent3_display_name=matchup.get("opponent3_display_name", ""),
                    opponent3_avatar_url=matchup.get("opponent3_avatar_url", ""),
                    streamer_rank=computed_rank,
                )

            record_battle_finish(
                battle_db_id=db_id,
                streamer_score=s_score,
                opponent_score=o_score,
                result=result,
                streamer_mvp_name=army_data["streamer_mvp_name"] or (active.get("streamer_mvp_name", "") if active else ""),
                streamer_mvp_score=army_data["streamer_mvp_score"] or (active.get("streamer_mvp_score", 0) if active else 0),
                streamer_mvp_avatar=army_data["streamer_mvp_avatar"] or (active.get("streamer_mvp_avatar", "") if active else ""),
                opponent_mvp_name=army_data["opponent_mvp_name"] or (active.get("opponent_mvp_name", "") if active else ""),
                opponent_mvp_score=army_data["opponent_mvp_score"] or (active.get("opponent_mvp_score", 0) if active else 0),
                opponent_mvp_avatar=army_data["opponent_mvp_avatar"] or (active.get("opponent_mvp_avatar", "") if active else ""),
                teammate_score=tm_score,
                opponent2_score=op2_score,
                opponent3_score=op3_score,
                streamer_rank=computed_rank,
                battle_mode=b_mode,
            )

            with self._lock:
                self._active_battle = None

            rank_str = f" (Platz #{computed_rank})" if computed_rank > 0 else ""
            opp_label = active.get("opponent_username", "") if active else ""
            opp_display = f"@{opp_label}" if opp_label else "Gegner"
            self._log("INFO", f"⚔️ Duell beendet ({b_mode}): @{self.username} ({s_score:,}{rank_str}) VS {opp_display} ({o_score:,}) -> {result}!")

        # Zwischenstände während des laufenden Matches
        elif self._active_battle and armies:
            army_data = self._extract_armies_and_mvps(armies, matchup=self._active_battle)
            with self._lock:
                if self._active_battle:
                    self._active_battle["streamer_score"] = army_data["streamer_score"]
                    self._active_battle["opponent_score"] = army_data["opponent_score"]
                    if army_data.get("teammate_score"):
                        self._active_battle["teammate_score"] = army_data["teammate_score"]
                    if army_data.get("opponent2_score"):
                        self._active_battle["opponent2_score"] = army_data["opponent2_score"]
                    if army_data.get("opponent3_score"):
                        self._active_battle["opponent3_score"] = army_data["opponent3_score"]

                    if army_data["streamer_mvp_name"]:
                        self._active_battle["streamer_mvp_name"] = army_data["streamer_mvp_name"]
                        self._active_battle["streamer_mvp_score"] = army_data["streamer_mvp_score"]
                        self._active_battle["streamer_mvp_avatar"] = army_data["streamer_mvp_avatar"]
                    if army_data["opponent_mvp_name"]:
                        self._active_battle["opponent_mvp_name"] = army_data["opponent_mvp_name"]
                        self._active_battle["opponent_mvp_score"] = army_data["opponent_mvp_score"]
                        self._active_battle["opponent_mvp_avatar"] = army_data["opponent_mvp_avatar"]
                    db_id = self._active_battle["db_id"]

            update_battle_scores(
                battle_db_id=db_id,
                streamer_score=army_data["streamer_score"],
                opponent_score=army_data["opponent_score"],
                teammate_score=army_data.get("teammate_score") or None,
                opponent2_score=army_data.get("opponent2_score") or None,
                opponent3_score=army_data.get("opponent3_score") or None,
                streamer_mvp_name=army_data["streamer_mvp_name"] or None,
                streamer_mvp_score=army_data["streamer_mvp_score"] or None,
                streamer_mvp_avatar=army_data["streamer_mvp_avatar"] or None,
                opponent_mvp_name=army_data["opponent_mvp_name"] or None,
                opponent_mvp_score=army_data["opponent_mvp_score"] or None,
                opponent_mvp_avatar=army_data["opponent_mvp_avatar"] or None,
            )

    def _handle_armies_event(self, event: Any) -> None:
        """
        Verarbeitet LinkMicArmiesEvents bei neuen Geschenken/Punkteständen während des Duells.
        """
        battle_id = str(getattr(event, "battle_id", "") or "")
        armies = getattr(event, "armies", None) or getattr(event, "team_armies", None)
        if not armies:
            return

        with self._lock:
            active = self._active_battle

        if not active:
            # Falls kein OPEN-Event kam, matchup extrahieren
            matchup = self._extract_battle_matchup(event)
            db_id = record_battle_start(
                streamer_id=self.streamer_id,
                battle_id=battle_id or str(int(time.time())),
                opponent_username=matchup["opponent_username"],
                opponent_display_name=matchup["opponent_display_name"],
                opponent_avatar_url=matchup["opponent_avatar_url"],
                opponent_user_id=matchup["opponent_user_id"],
                session_id=self.diag.session_id,
                battle_mode=matchup["battle_mode"],
                teammate_user_id=matchup["teammate_user_id"],
                teammate_username=matchup["teammate_username"],
                teammate_display_name=matchup["teammate_display_name"],
                teammate_avatar_url=matchup["teammate_avatar_url"],
                opponent2_user_id=matchup["opponent2_user_id"],
                opponent2_username=matchup["opponent2_username"],
                opponent2_display_name=matchup["opponent2_display_name"],
                opponent2_avatar_url=matchup["opponent2_avatar_url"],
                opponent3_user_id=matchup.get("opponent3_user_id", ""),
                opponent3_username=matchup.get("opponent3_username", ""),
                opponent3_display_name=matchup.get("opponent3_display_name", ""),
                opponent3_avatar_url=matchup.get("opponent3_avatar_url", ""),
            )
            with self._lock:
                self._active_battle = {
                    "db_id": db_id,
                    "battle_id": battle_id,
                    "battle_mode": matchup["battle_mode"],
                    "opponent_user_id": matchup["opponent_user_id"],
                    "opponent_username": matchup["opponent_username"],
                    "opponent_display_name": matchup["opponent_display_name"],
                    "opponent_avatar_url": matchup["opponent_avatar_url"],
                    "teammate_user_id": matchup["teammate_user_id"],
                    "teammate_username": matchup["teammate_username"],
                    "teammate_display_name": matchup["teammate_display_name"],
                    "teammate_avatar_url": matchup["teammate_avatar_url"],
                    "opponent2_user_id": matchup["opponent2_user_id"],
                    "opponent2_username": matchup["opponent2_username"],
                    "opponent2_display_name": matchup["opponent2_display_name"],
                    "opponent2_avatar_url": matchup["opponent2_avatar_url"],
                    "opponent3_user_id": matchup.get("opponent3_user_id", ""),
                    "opponent3_username": matchup.get("opponent3_username", ""),
                    "opponent3_display_name": matchup.get("opponent3_display_name", ""),
                    "opponent3_avatar_url": matchup.get("opponent3_avatar_url", ""),
                    "streamer_rank": 0,
                    "started_at": datetime.now().isoformat(timespec="seconds"),
                    "streamer_score": 0,
                    "opponent_score": 0,
                    "teammate_score": 0,
                    "opponent2_score": 0,
                    "opponent3_score": 0,
                    "streamer_mvp_name": "",
                    "streamer_mvp_score": 0,
                    "streamer_mvp_avatar": "",
                    "opponent_mvp_name": "",
                    "opponent_mvp_score": 0,
                    "opponent_mvp_avatar": "",
                    "coins_earned": 0,
                }
                active = self._active_battle

        army_data = self._extract_armies_and_mvps(armies, matchup=active)

        with self._lock:
            if self._active_battle:
                self._active_battle["streamer_score"] = army_data["streamer_score"]
                self._active_battle["opponent_score"] = army_data["opponent_score"]
                if army_data.get("teammate_score"):
                    self._active_battle["teammate_score"] = army_data["teammate_score"]
                if army_data.get("opponent2_score"):
                    self._active_battle["opponent2_score"] = army_data["opponent2_score"]
                if army_data.get("opponent3_score"):
                    self._active_battle["opponent3_score"] = army_data["opponent3_score"]

                if army_data["streamer_mvp_name"]:
                    self._active_battle["streamer_mvp_name"] = army_data["streamer_mvp_name"]
                    self._active_battle["streamer_mvp_score"] = army_data["streamer_mvp_score"]
                    self._active_battle["streamer_mvp_avatar"] = army_data["streamer_mvp_avatar"]
                if army_data["opponent_mvp_name"]:
                    self._active_battle["opponent_mvp_name"] = army_data["opponent_mvp_name"]
                    self._active_battle["opponent_mvp_score"] = army_data["opponent_mvp_score"]
                    self._active_battle["opponent_mvp_avatar"] = army_data["opponent_mvp_avatar"]
                db_id = self._active_battle["db_id"]

        update_battle_scores(
            battle_db_id=db_id,
            streamer_score=army_data["streamer_score"],
            opponent_score=army_data["opponent_score"],
            teammate_score=army_data.get("teammate_score") or None,
            opponent2_score=army_data.get("opponent2_score") or None,
            opponent3_score=army_data.get("opponent3_score") or None,
            streamer_mvp_name=army_data["streamer_mvp_name"] or None,
            streamer_mvp_score=army_data["streamer_mvp_score"] or None,
            streamer_mvp_avatar=army_data["streamer_mvp_avatar"] or None,
            opponent_mvp_name=army_data["opponent_mvp_name"] or None,
            opponent_mvp_score=army_data["opponent_mvp_score"] or None,
            opponent_mvp_avatar=army_data["opponent_mvp_avatar"] or None,
        )

    def _finish_active_battle_if_any(self) -> None:
        """
        Beendet ein offenes Duell beim Server-Shutdown oder Stream-Ende sauber.
        """
        with self._lock:
            active = self._active_battle
            self._active_battle = None
        if not active:
            return
        try:
            s_score = int(active.get("streamer_score", 0) or 0)
            o_score = int(active.get("opponent_score", 0) or 0)
            op2_score = int(active.get("opponent2_score", 0) or 0)
            op3_score = int(active.get("opponent3_score", 0) or 0)
            b_mode = active.get("battle_mode", "1v1")
            computed_rank = 0

            if b_mode in ("1v1v1", "1v1v1v1"):
                scores = [("streamer", s_score), ("opp1", o_score), ("opp2", op2_score)]
                if b_mode == "1v1v1v1":
                    scores.append(("opp3", op3_score))
                scores_sorted = sorted(scores, key=lambda x: x[1], reverse=True)
                for idx, (who, _) in enumerate(scores_sorted):
                    if who == "streamer":
                        computed_rank = idx + 1
                        break
                if computed_rank == 1:
                    if len(scores_sorted) > 1 and scores_sorted[0][1] == scores_sorted[1][1] and scores_sorted[0][1] > 0:
                        res = "DRAW"
                    else:
                        res = "WIN"
                else:
                    res = "LOSE"
            else:
                if s_score > o_score:
                    res = "WIN"
                elif s_score < o_score:
                    res = "LOSE"
                else:
                    res = "DRAW"

            record_battle_finish(
                battle_db_id=active["db_id"],
                streamer_score=s_score,
                opponent_score=o_score,
                result=res,
                streamer_mvp_name=active.get("streamer_mvp_name", ""),
                streamer_mvp_score=active.get("streamer_mvp_score", 0),
                streamer_mvp_avatar=active.get("streamer_mvp_avatar", ""),
                opponent_mvp_name=active.get("opponent_mvp_name", ""),
                opponent_mvp_score=active.get("opponent_mvp_score", 0),
                opponent_mvp_avatar=active.get("opponent_mvp_avatar", ""),
                teammate_score=active.get("teammate_score", 0),
                opponent2_score=active.get("opponent2_score", 0),
                opponent3_score=active.get("opponent3_score", 0),
                streamer_rank=computed_rank,
                battle_mode=active.get("battle_mode", "1v1"),
            )
        except Exception as exc:
            logger.debug("Fehler beim Beenden des aktiven Battles für @%s: %s", self.username, exc)
        except Exception as exc:
            logger.debug("Fehler beim Beenden des aktiven Battles für @%s: %s", self.username, exc)

    def _cache_gift_catalog(self, gift_info: Any) -> None:
        if not isinstance(gift_info, dict):
            return
        gifts = gift_info.get("gifts") or gift_info.get("data", {}).get("gifts") or []
        if not isinstance(gifts, list):
            return
        for g in gifts:
            if not isinstance(g, dict):
                continue
            gid = int(g.get("id") or 0)
            if not gid:
                continue
            gname = str(g.get("name") or f"Gift #{gid}")
            diamonds = int(g.get("diamond_count") or 0)
            icon_url = ""
            icon_obj = g.get("icon") or g.get("image") or {}
            if isinstance(icon_obj, dict):
                urls = icon_obj.get("url_list") or []
                if urls:
                    icon_url = str(urls[0])
            self._gift_catalog_cache[gid] = (gname, diamonds, icon_url)

    def _extract_gift_metadata(self, event: Any) -> Dict[str, Any]:
        gift = getattr(event, "gift", None)
        gift_id = int(getattr(event, "gift_id", 0) or getattr(gift, "id", 0) or 0)
        gift_name = str(getattr(gift, "name", "") or "")
        diamond_count = int(getattr(gift, "diamond_count", 0) or 0)
        gift_icon_url = ""

        icon_obj = getattr(gift, "icon", None) or getattr(gift, "image", None)
        if icon_obj is not None:
            url_list = getattr(icon_obj, "url_list", None) or []
            if url_list:
                gift_icon_url = str(url_list[0])

        if gift_id in self._gift_catalog_cache:
            cat_name, cat_diamonds, cat_icon = self._gift_catalog_cache[gift_id]
            if not gift_name:
                gift_name = cat_name
            if diamond_count <= 0:
                diamond_count = cat_diamonds
            if not gift_icon_url:
                gift_icon_url = cat_icon

        if not gift_name:
            gift_name = f"Gift #{gift_id}" if gift_id else "TikTok Gift"

        if diamond_count <= 0:
            diamond_count = KNOWN_GIFT_DIAMONDS.get(gift_name.lower(), 1)

        repeat_count = max(1, int(getattr(event, "repeat_count", 1) or 1))
        combo_count = max(1, int(getattr(event, "combo_count", repeat_count) or repeat_count))
        group_id = str(getattr(event, "group_id", "") or "")
        room_fan_tickets = int(getattr(event, "room_fan_ticket_count", 0) or 0)

        user = getattr(event, "user", None)
        sender_user_id = str(getattr(user, "id", "") or "")
        sender_username = str(
            getattr(user, "unique_id", None)
            or getattr(user, "username", None)
            or sender_user_id
            or "viewer"
        )
        sender_nickname = str(getattr(user, "nickname", None) or sender_username)
        is_super_fan = bool(getattr(event, "user_is_super_fan", False))

        common = getattr(event, "common", None)
        msg_id = str(getattr(common, "msg_id", "") or getattr(event, "log_id", "") or "")

        streaking = bool(getattr(event, "streaking", False))

        streak_key = f"{sender_user_id or sender_username}:{gift_id}:{group_id or 'default'}"

        if group_id and group_id != "0":
            raw_uid = f"tt:{self.streamer_id}:{sender_user_id or sender_username}:{gift_id}:grp:{group_id}"
        elif msg_id:
            raw_uid = f"tt:{self.streamer_id}:msg:{msg_id}"
        else:
            raw_uid = (
                f"tt:{self.streamer_id}:{sender_username}:{gift_id}:"
                f"{repeat_count}:{int(time.time())}"
            )
        event_uid = hashlib.sha1(raw_uid.encode("utf-8")).hexdigest()

        return {
            "gift_id": gift_id,
            "gift_name": gift_name,
            "diamond_count": diamond_count,
            "gift_icon_url": gift_icon_url,
            "repeat_count": repeat_count,
            "combo_count": combo_count,
            "group_id": group_id,
            "room_fan_tickets": room_fan_tickets,
            "sender_user_id": sender_user_id,
            "sender_username": sender_username,
            "sender_nickname": sender_nickname,
            "is_super_fan": is_super_fan,
            "streaking": streaking,
            "streak_key": streak_key,
            "event_uid": event_uid,
        }

    def _process_gift_event(self, event: Any) -> None:
        meta = self._extract_gift_metadata(event)
        now_iso = datetime.now().isoformat(timespec="seconds")

        with self._lock:
            self.diag.last_event_at = now_iso
            if meta["room_fan_tickets"] > 0:
                self.diag.room_fan_tickets = max(
                    self.diag.room_fan_tickets, meta["room_fan_tickets"]
                )
            session_id = self.diag.session_id

        streak_key = meta["streak_key"]

        if meta["streaking"]:
            with self._lock:
                self._pending_streaks[streak_key] = PendingStreak(
                    streamer_id=self.streamer_id,
                    session_id=session_id,
                    sender_user_id=meta["sender_user_id"],
                    sender_username=meta["sender_username"],
                    sender_nickname=meta["sender_nickname"],
                    is_super_fan=meta["is_super_fan"],
                    gift_id=meta["gift_id"],
                    gift_name=meta["gift_name"],
                    gift_icon_url=meta["gift_icon_url"],
                    diamond_count=meta["diamond_count"],
                    repeat_count=meta["repeat_count"],
                    combo_count=meta["combo_count"],
                    group_id=meta["group_id"],
                    room_fan_tickets=meta["room_fan_tickets"],
                    event_uid=meta["event_uid"],
                    updated_at=time.monotonic(),
                )
            return

        with self._lock:
            self._pending_streaks.pop(streak_key, None)

        self._commit_gift(
            session_id=session_id,
            sender_user_id=meta["sender_user_id"],
            sender_username=meta["sender_username"],
            sender_nickname=meta["sender_nickname"],
            is_super_fan=meta["is_super_fan"],
            gift_id=meta["gift_id"],
            gift_name=meta["gift_name"],
            gift_icon_url=meta["gift_icon_url"],
            diamond_count=meta["diamond_count"],
            repeat_count=meta["repeat_count"],
            combo_count=meta["combo_count"],
            group_id=meta["group_id"],
            room_fan_tickets=meta["room_fan_tickets"],
            event_uid=meta["event_uid"],
        )

    def _commit_gift(
        self,
        session_id: Optional[int],
        sender_user_id: str,
        sender_username: str,
        sender_nickname: str,
        is_super_fan: bool,
        gift_id: int,
        gift_name: str,
        gift_icon_url: str,
        diamond_count: int,
        repeat_count: int,
        combo_count: int,
        group_id: str,
        room_fan_tickets: int,
        event_uid: str,
    ) -> None:
        record, created = record_gift_event(
            streamer_id=self.streamer_id,
            session_id=session_id,
            event_uid=event_uid,
            sender_user_id=sender_user_id,
            sender_username=sender_username,
            sender_nickname=sender_nickname,
            is_super_fan=is_super_fan,
            gift_id=gift_id,
            gift_name=gift_name,
            gift_icon_url=gift_icon_url,
            diamond_count=diamond_count,
            repeat_count=repeat_count,
            combo_count=combo_count,
            group_id=group_id,
            room_fan_tickets=room_fan_tickets,
            source="tiktoklive",
        )
        if created and record:
            coins = int(record["total_coins"])
            tier = get_donor_tier(coins)
            if tier:
                update_cached_donor_tier(sender_username, tier)
            with self._lock:
                self.diag.gifts_received_session += repeat_count
                self.diag.coins_received_session += coins
                if self._active_battle is not None:
                    self._active_battle["coins_earned"] = (
                        self._active_battle.get("coins_earned", 0) + coins
                    )
            self._log(
                "INFO",
                f"Gift erfasst: {repeat_count}x {gift_name} ({coins} Coins) von @{sender_username}",
            )


    def _flush_expired_streaks(self) -> None:
        now = time.monotonic()
        expired: List[PendingStreak] = []
        with self._lock:
            keys_to_pop = [
                k
                for k, ps in self._pending_streaks.items()
                if (now - ps.updated_at) >= self.STREAK_TIMEOUT_SECONDS
            ]
            for k in keys_to_pop:
                expired.append(self._pending_streaks.pop(k))

        for ps in expired:
            self._commit_gift(
                session_id=ps.session_id,
                sender_user_id=ps.sender_user_id,
                sender_username=ps.sender_username,
                sender_nickname=ps.sender_nickname,
                is_super_fan=ps.is_super_fan,
                gift_id=ps.gift_id,
                gift_name=ps.gift_name,
                gift_icon_url=ps.gift_icon_url,
                diamond_count=ps.diamond_count,
                repeat_count=ps.repeat_count,
                combo_count=ps.combo_count,
                group_id=ps.group_id,
                room_fan_tickets=ps.room_fan_tickets,
                event_uid=ps.event_uid,
            )

    def _flush_all_pending_streaks(self) -> None:
        with self._lock:
            pending = list(self._pending_streaks.values())
            self._pending_streaks.clear()

        for ps in pending:
            self._commit_gift(
                session_id=ps.session_id,
                sender_user_id=ps.sender_user_id,
                sender_username=ps.sender_username,
                sender_nickname=ps.sender_nickname,
                is_super_fan=ps.is_super_fan,
                gift_id=ps.gift_id,
                gift_name=ps.gift_name,
                gift_icon_url=ps.gift_icon_url,
                diamond_count=ps.diamond_count,
                repeat_count=ps.repeat_count,
                combo_count=ps.combo_count,
                group_id=ps.group_id,
                room_fan_tickets=ps.room_fan_tickets,
                event_uid=ps.event_uid,
            )

    def _process_comment_event(self, event: Any) -> None:
        user = getattr(event, "user", None)
        u_id = str(getattr(user, "user_id", "") or getattr(user, "id", "") or "")
        username = str(
            getattr(user, "unique_id", None)
            or getattr(user, "username", None)
            or u_id
            or "viewer"
        ).strip().lstrip("@")
        nickname = str(getattr(user, "nickname", None) or getattr(user, "nick_name", None) or username).strip()

        avatar_url = ""
        avatar_thumb = getattr(user, "avatar_thumb", None) or getattr(user, "avatar_medium", None)
        if avatar_thumb:
            urls = getattr(avatar_thumb, "url_list", None) or []
            if urls:
                avatar_url = str(urls[0])

        comment_text = str(getattr(event, "comment", None) or getattr(event, "content", "") or "").strip()
        if not comment_text:
            return

        tier = get_cached_donor_tier(username)
        is_whale = bool(tier)

        with self._lock:
            session_id = self.diag.session_id

        msg = {
            "streamer_id": self.streamer_id,
            "session_id": session_id,
            "user_id": u_id,
            "username": username,
            "nickname": nickname,
            "avatar_url": avatar_url,
            "comment": comment_text,
            "is_whale": is_whale,
            "whale_tier": tier,
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }

        with self._chat_buffer_lock:
            self._chat_buffer.append(msg)
            if len(self._chat_buffer) > 1000:
                self._chat_buffer = self._chat_buffer[-1000:]

    def _flush_chat_buffer(self) -> None:
        with self._chat_buffer_lock:
            if not self._chat_buffer:
                return
            batch = self._chat_buffer
            self._chat_buffer = []

        try:
            batch_record_chat_messages(batch)
        except Exception as exc:
            logger.error("[@%s] Fehler beim Speichern von Chat-Nachrichten: %s", self.username, exc)


class StreamerMonitorManager:

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._workers: Dict[str, StreamerWorker] = {}
        self._autostart_done = False

    def is_tracking(self, username: str) -> bool:
        clean = username.strip().lstrip("@").lower()
        with self._lock:
            worker = self._workers.get(clean)
            return bool(worker and worker.is_alive())

    def get_status(self, username: str) -> str:
        clean = username.strip().lstrip("@").lower()
        with self._lock:
            worker = self._workers.get(clean)
            if not worker:
                return "Inaktiv"
            snap = worker.get_snapshot()
            return f"[{snap['state']}] {snap['last_message']}"

    def get_worker_diagnostics(self, username: str) -> Optional[Dict[str, Any]]:
        clean = username.strip().lstrip("@").lower()
        with self._lock:
            worker = self._workers.get(clean)
            return worker.get_snapshot() if worker else None

    def get_all_diagnostics(self) -> Dict[str, Any]:
        with self._lock:
            snapshots = [w.get_snapshot() for w in self._workers.values()]
        active_count = sum(1 for s in snapshots if s["is_running"])
        connected_count = sum(1 for s in snapshots if s["state"] == "connected")
        return {
            "tiktoklive_available": TIKTOKLIVE_AVAILABLE,
            "env_config": config.public_summary(),
            "workers_total": len(snapshots),
            "workers_running": active_count,
            "workers_connected": connected_count,
            "workers": snapshots,
        }

    def autostart_from_db(self, force: bool = False) -> List[str]:
        """
        Startet beim Programmstart automatisch alle Streamer, die in der Datenbank
        mit `auto_monitor = 1` oder `is_tracking = 1` markiert sind.
        """
        with self._lock:
            if self._autostart_done and not force:
                return []
            self._autostart_done = True

        try:
            refresh_donor_tier_cache()
            cleanup_old_chat_messages(days=7)
        except Exception as exc:
            logger.debug("Chatlog/Donor Cleanup Fehler bei Autostart: %s", exc)

        marked_streamers = get_auto_monitor_streamers()

        if not marked_streamers:
            logger.info("Auto-Start: Keine markierten Streamer in der Datenbank gefunden.")
            return []

        started_usernames: List[str] = []
        for s in marked_streamers:
            uname = str(s["username"]).strip().lstrip("@").lower()
            if not self.is_tracking(uname):
                self.start_tracking(int(s["id"]), uname, auto_reconnect=True)
                started_usernames.append(uname)

        if started_usernames:
            logger.info(
                "Auto-Start: Aufzeichnung für %d markierte Streamer aus der DB gestartet: %s",
                len(started_usernames),
                ", ".join(f"@{u}" for u in started_usernames),
            )
        return started_usernames

    def start_tracking(
        self, streamer_id: int, username: str, auto_reconnect: bool = True
    ) -> Dict[str, Any]:
        clean = username.strip().lstrip("@").lower()
        if not TIKTOKLIVE_AVAILABLE:
            return {
                "ok": False,
                "message": "TikTokLive-Bibliothek ist nicht installiert.",
            }

        # Sofort in der Datenbank als aktiv / Auto-Monitor markieren
        update_streamer_runtime_state(
            clean,
            is_tracking=True,
            auto_monitor=bool(auto_reconnect),
        )

        with self._lock:
            worker = self._workers.get(clean)
            if worker and worker.is_alive():
                return {
                    "ok": True,
                    "message": f"Worker für @{clean} läuft bereits.",
                    "diagnostics": worker.get_snapshot(),
                }
            worker = StreamerWorker(
                streamer_id=streamer_id,
                username=clean,
                auto_reconnect=auto_reconnect,
            )
            self._workers[clean] = worker

        worker.start(auto_reconnect=auto_reconnect)
        return {
            "ok": True,
            "message": f"TikTokLive-Worker für @{clean} gestartet (Auto-Monitor={auto_reconnect}).",
            "diagnostics": worker.get_snapshot(),
        }

    def stop_tracking(self, username: str) -> Dict[str, Any]:
        clean = username.strip().lstrip("@").lower()
        with self._lock:
            worker = self._workers.get(clean)

        if worker:
            worker.stop(preserve_db_state=False)
        else:
            update_streamer_runtime_state(
                clean,
                is_live=False,
                is_tracking=False,
                auto_monitor=False,
                current_viewers=0,
            )

        return {
            "ok": True,
            "message": f"Worker für @{clean} gestoppt.",
        }

    def stop_all(self) -> None:
        """
        Wird beim Beenden / Neustarten des Servers aufgerufen.
        Beendet alle laufenden Worker-Verbindungen sauber, behält aber die
        Markierung (`auto_monitor = 1` / `is_tracking = 1`) in der Datenbank bei!
        """
        with self._lock:
            workers = list(self._workers.values())
        for w in workers:
            w.stop(preserve_db_state=True)


monitor_manager = StreamerMonitorManager()
