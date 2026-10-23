import asyncio
import csv
import hashlib
import io
import json
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from config import config
from database import (
    build_streamer_bot_report,
    clear_demo_data,
    delete_streamer,
    delete_telegram_user,
    get_analytics_data,
    get_battles_list,
    get_battle_stats,
    get_battle_details,
    get_chat_messages,
    get_dashboard_overview,
    get_db,
    get_donor_crm,
    get_donor_details,
    get_donor_radar_data,
    get_network_loyalty_and_overlap,
    get_recent_whale_gifts,
    get_settings,
    get_site_analytics_overview,
    get_streamer_by_id_or_username,
    get_streamer_detail,
    get_telegram_access_mode,
    init_db,
    inspect_sqlite_database,
    import_from_sqlite_database,
    check_telegram_user_access,
    list_telegram_users,
    record_bot_session,
    record_gift_event,
    record_page_view,
    save_donor_crm,
    seed_demo_data,
    toggle_donor_vip,
    update_settings,
    upsert_streamer,
    upsert_telegram_user_permission,
)
from schemas import (
    DailyBotReportResponse,
    DonorCRMUpdateRequest,
    GiftCreateRequest,
    MiniAppAuthRequest,
    MiniAppVerifyCodeRequest,
    SettingsUpdateRequest,
    SqliteImportRequest,
    StreamerCreateRequest,
    StreamerReportCard,
    TelegramUserPermissionRequest,
    TrackActionRequest,
)
from system_service import get_system_health
from telegram_service import (
    AdminAuthManager,
    admin_auth_manager,
    generate_full_report_data,
    telegram_bot_service,
)
from tiktok_service import TIKTOKLIVE_AVAILABLE, fetch_tiktok_user_info, monitor_manager

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

TIKTOK_GIFT_CATALOG = [
    {"id": 5655, "name": "Rose", "diamonds": 1},
    {"id": 5487, "name": "Finger Heart", "diamonds": 5},
    {"id": 5879, "name": "Doughnut", "diamonds": 30},
    {"id": 6104, "name": "Cap", "diamonds": 99},
    {"id": 5658, "name": "Corgi", "diamonds": 299},
    {"id": 5585, "name": "Money Gun", "diamonds": 500},
    {"id": 5827, "name": "Galaxy", "diamonds": 1000},
    {"id": 6267, "name": "Whale Diving", "diamonds": 2150},
    {"id": 5660, "name": "Sports Car", "diamonds": 7000},
    {"id": 6427, "name": "Sunset Speedway", "diamonds": 10000},
    {"id": 6369, "name": "Falcon", "diamonds": 10999},
    {"id": 7123, "name": "Dragon Flame", "diamonds": 26999},
    {"id": 5997, "name": "Lion", "diamonds": 29999},
    {"id": 9999, "name": "TikTok Universe", "diamonds": 44999},
]


class TelegramLoginRequestPayload(BaseModel):
    identifier: Optional[str] = None


class TelegramLoginVerifyPayload(BaseModel):
    code: str
    challenge_id: Optional[str] = None


@asynccontextmanager
async def lifespan(app_instance: FastAPI):
    """
    FastAPI Lifespan:
    1. Initialisiert die Datenbank (SQLite oder MySQL)
    2. Startet automatisch alle TikTokLive-Worker für Streamer, die in der DB mit
       auto_monitor=1 oder is_tracking=1 markiert sind
    3. Startet optional den Telegram-Bot-Service (fehlertolerant isoliert: falls der Bot
       nicht starten kann, laufen FastAPI und das Web-Interface garantiert trotzdem weiter)
    """
    init_db()
    with get_db() as conn:
        count = conn.execute("SELECT COUNT(*) FROM streamers").fetchone()[0]
        if count == 0:
            seed_demo_data()

    monitor_manager.autostart_from_db()

    await telegram_bot_service.start()

    yield

    await telegram_bot_service.stop()
    monitor_manager.stop_all()


app = FastAPI(
    title="toktracker – Streamer Earnings & Bot API",
    description=(
        "toktracker Backend-Service zur Echtzeit-Erfassung von TikTokLive-Geschenken (Coins/Diamonds) "
        "mit öffentlichem User-Panel (/), Telegram-geschütztem Admin-Panel (/admin) und integriertem Telegram-Bot."
    ),
    version="2.5.0",
    lifespan=lifespan,
)

app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
if os.path.isdir(os.path.join(BASE_DIR, "pictures")):
    app.mount("/pictures", StaticFiles(directory=os.path.join(BASE_DIR, "pictures")), name="pictures")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))


def _extract_client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    x_real = request.headers.get("x-real-ip")
    if x_real:
        return x_real.strip()
    if request.client and request.client.host:
        return request.client.host
    return "127.0.0.1"


def _detect_device_type(user_agent: str) -> str:
    ua = (user_agent or "").lower()
    if any(b in ua for b in ["bot", "spider", "crawler", "crawl", "slurp", "googlebot", "bingbot", "yandex"]):
        return "bot"
    if "ipad" in ua or "tablet" in ua:
        return "tablet"
    if any(m in ua for m in ["mobile", "android", "iphone", "ipod", "windows phone"]):
        return "mobile"
    return "desktop"


@app.middleware("http")
async def track_page_views_middleware(request: Request, call_next):
    start_time = time.time()
    response = await call_next(request)
    duration_ms = (time.time() - start_time) * 1000.0

    path = request.url.path
    if request.method == "GET" and not path.startswith((
        "/static", "/pictures", "/api", "/docs", "/openapi", "/redoc", "/favicon.ico"
    )):
        try:
            client_ip = _extract_client_ip(request)
            salt = config.session_secret or "toktracker_salt_2026"
            visitor_hash = hashlib.sha256(f"{client_ip}:{salt}".encode("utf-8")).hexdigest()[:20]
            ua = request.headers.get("user-agent", "")
            dev_type = _detect_device_type(ua)
            ref = request.headers.get("referer", "")

            record_page_view(
                path=path,
                visitor_hash=visitor_hash,
                user_agent=ua,
                device_type=dev_type,
                referrer=ref,
                status_code=response.status_code,
                response_time_ms=duration_ms,
            )
        except Exception:
            pass

    return response


def verify_admin_or_api_key(
    toktracker_admin_session: Optional[str] = Cookie(default=None),
    x_admin_session: Optional[str] = Header(default=None, alias="X-Admin-Session"),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
    api_key: Optional[str] = Query(default=None, description="Optionaler API-Key per Query-Parameter"),
) -> Dict[str, Any]:
    """
    Schützt alle Admin- und Verwaltungs-Endpunkte:
    1. Prüft zuerst auf ein gültiges, signiertes Admin-Session-Cookie oder Header (Telegram-Login).
    2. Prüft alternativ auf einen konfigurierten X-API-Key (für externe Skripte/Automationen).
    """
    token = toktracker_admin_session or x_admin_session
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    session_payload = admin_auth_manager.verify_session_token(token)
    if session_payload:
        return session_payload

    configured_key = (config.api_key or get_settings().get("api_key") or "").strip()
    provided = (x_api_key or api_key or "").strip()
    if configured_key and provided and provided == configured_key:
        return {"sub": "api_key"}

    raise HTTPException(
        status_code=401,
        detail="Nicht autorisiert. Bitte unter /login per Telegram authentifizieren oder gültigen X-API-Key übergeben.",
    )


def verify_radar_access(
    toktracker_admin_session: Optional[str] = Cookie(default=None),
    x_admin_session: Optional[str] = Header(default=None, alias="X-Admin-Session"),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
    api_key: Optional[str] = Query(default=None, description="Optionaler API-Key per Query-Parameter"),
) -> Dict[str, Any]:
    """
    Erlaubt Zugriff auf das Spender-Radar für:
    1. Authentifizierte Admins & freigeschaltete Telegram-Mini-App-Nutzer
    2. API-Key-Inhaber
    3. Öffentlichen Zugriff, falls telegram_access_mode == 'public'
    """
    token = toktracker_admin_session or x_admin_session
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    if token:
        session_payload = admin_auth_manager.verify_session_token(token)
        if session_payload:
            return session_payload

    configured_key = (config.api_key or get_settings().get("api_key") or "").strip()
    provided = (x_api_key or api_key or "").strip()
    if configured_key and provided and provided == configured_key:
        return {"sub": "api_key"}

    if get_telegram_access_mode() == "public":
        return {"role": "public", "is_allowed": True}

    raise HTTPException(
        status_code=401,
        detail="Nicht autorisiert für Spender-Radar. Bitte im Telegram-Bot freischalten lassen.",
    )


def _set_admin_session_cookie(response: Response, admin_label: str) -> None:
    token = admin_auth_manager.create_session_token(admin_label=admin_label)
    response.set_cookie(
        key=AdminAuthManager.COOKIE_NAME,
        value=token,
        max_age=AdminAuthManager.SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        path="/",
    )


def _enrich_streamer_card(streamer_row: Dict[str, Any], hours: int) -> StreamerReportCard:
    uname = streamer_row["username"]
    is_tracking = monitor_manager.is_tracking(uname)
    diag = monitor_manager.get_worker_diagnostics(uname)
    worker_state = diag["state"] if diag else ("live" if streamer_row.get("is_live") else "stopped")
    card_dict = build_streamer_bot_report(
        streamer_row=streamer_row,
        hours=hours,
        is_tracking_active=is_tracking,
        worker_state=worker_state,
    )
    return StreamerReportCard(**card_dict)


# =====================================================================
# 1. TOKTRACKER WEB-INTERFACE: PUBLIC PANEL (/), LOGIN (/login) & ADMIN (/admin)
# =====================================================================

@app.get("/", response_class=HTMLResponse, include_in_schema=False)
@app.get("/public", response_class=HTMLResponse, include_in_schema=False)
@app.get("/panel", response_class=HTMLResponse, include_in_schema=False)
async def public_panel(request: Request):
    """
    Startseite (/): Öffentliches User-Panel für Zuschauer (Read-Only).
    """
    tg_diag = telegram_bot_service.get_diagnostics()
    return templates.TemplateResponse(
        request=request,
        name="public.html",
        context={
            "telegram_bot_username": tg_diag.get("bot_username") or "",
            "telegram_state": tg_diag.get("state") or "offline",
        },
    )


@app.get("/miniapp", response_class=HTMLResponse, include_in_schema=False)
@app.get("/webapp", response_class=HTMLResponse, include_in_schema=False)
@app.get("/app", response_class=HTMLResponse, include_in_schema=False)
async def miniapp_page(request: Request):
    """
    Mobile-First Telegram Mini-App & WebApp (/miniapp):
    Kompakte Übersicht über Live-Matches, Einnahmen, Streamer und Geschenke.
    """
    tg_diag = telegram_bot_service.get_diagnostics()
    return templates.TemplateResponse(
        request=request,
        name="miniapp.html",
        context={
            "telegram_bot_username": tg_diag.get("bot_username") or "",
            "telegram_state": tg_diag.get("state") or "offline",
            "webapp_url": config.telegram_webapp_url or "",
        },
    )


@app.get("/login", response_class=HTMLResponse, include_in_schema=False)
async def admin_login_page(
    request: Request,
    toktracker_admin_session: Optional[str] = Cookie(default=None),
):
    """
    Login-Seite (/login) für die Telegram-basierte Admin-Authentifizierung.
    """
    if admin_auth_manager.verify_session_token(toktracker_admin_session):
        return RedirectResponse(url="/admin", status_code=302)

    tg_diag = telegram_bot_service.get_diagnostics()
    return templates.TemplateResponse(
        request=request,
        name="login.html",
        context={
            "telegram_bot_username": tg_diag.get("bot_username") or "",
            "telegram_state": tg_diag.get("state") or "offline",
        },
    )


@app.get("/logout", include_in_schema=False)
async def admin_logout():
    response = RedirectResponse(url="/login", status_code=302)
    response.delete_cookie(key=AdminAuthManager.COOKIE_NAME, path="/")
    return response


@app.get("/admin", response_class=HTMLResponse, include_in_schema=False)
async def admin_console(
    request: Request,
    toktracker_admin_session: Optional[str] = Cookie(default=None),
):
    """
    Geschütztes Admin-Panel (/admin). Leitet ohne gültige Telegram-Session auf /login weiter.
    """
    session_payload = admin_auth_manager.verify_session_token(toktracker_admin_session)
    if not session_payload:
        return RedirectResponse(url="/login", status_code=302)

    init_db()
    monitor_manager.autostart_from_db()
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "tiktoklive_available": TIKTOKLIVE_AVAILABLE,
            "gift_catalog": TIKTOK_GIFT_CATALOG,
            "env_summary": config.public_summary(),
            "telegram_diag": telegram_bot_service.get_diagnostics(),
            "admin_sub": session_payload.get("sub", "TELEGRAM"),
        },
    )


@app.get("/site-analytics", response_class=HTMLResponse, include_in_schema=False)
async def site_analytics_page(
    request: Request,
    toktracker_admin_session: Optional[str] = Cookie(default=None),
):
    """
    Geschützte Analyse-Seite (/site-analytics). Leitet ohne gültige Telegram-Session auf /login weiter.
    """
    session_payload = admin_auth_manager.verify_session_token(toktracker_admin_session)
    if not session_payload:
        return RedirectResponse(url="/login", status_code=302)

    init_db()
    return templates.TemplateResponse(
        request=request,
        name="site_analytics.html",
        context={
            "tiktoklive_available": TIKTOKLIVE_AVAILABLE,
            "gift_catalog": TIKTOK_GIFT_CATALOG,
            "env_summary": config.public_summary(),
            "telegram_diag": telegram_bot_service.get_diagnostics(),
            "admin_sub": session_payload.get("sub", "TELEGRAM"),
        },
    )


@app.get("/donor-radar", response_class=HTMLResponse, include_in_schema=False)
async def donor_radar_page(
    request: Request,
    toktracker_admin_session: Optional[str] = Cookie(default=None),
):
    """
    Geschützte Spender-Radar & Chatlog-Seite (/donor-radar). Leitet ohne gültige Telegram-Session auf /login weiter.
    """
    session_payload = admin_auth_manager.verify_session_token(toktracker_admin_session)
    if not session_payload:
        return RedirectResponse(url="/login", status_code=302)

    init_db()
    return templates.TemplateResponse(
        request=request,
        name="donor_radar.html",
        context={
            "tiktoklive_available": TIKTOKLIVE_AVAILABLE,
            "gift_catalog": TIKTOK_GIFT_CATALOG,
            "env_summary": config.public_summary(),
            "telegram_diag": telegram_bot_service.get_diagnostics(),
            "admin_sub": session_payload.get("sub", "TELEGRAM"),
        },
    )



# =====================================================================
# 1b. TELEGRAM ADMIN-AUTH ENDPOINTS (/api/auth/telegram/*)
# =====================================================================

@app.post(
    "/api/auth/telegram/request",
    tags=["Admin Authentication"],
    summary="Fordert einen 6-stelligen Einmal-Code & 1-Klick-Freigabe über den Telegram-Bot an",
)
async def api_auth_telegram_request(request: Request, payload: TelegramLoginRequestPayload):
    init_db()
    client_host = request.client.host if request.client else "unbekannt"
    ua = (request.headers.get("user-agent") or "")[:48]
    client_info = f"{client_host} ({ua})" if ua else client_host

    res = await telegram_bot_service.send_admin_login_challenge(
        identifier_hint=payload.identifier,
        client_info=client_info,
    )
    if res.get("ok"):
        try:
            client_ip = _extract_client_ip(request)
            salt = config.session_secret or "toktracker_salt_2026"
            ip_hash = hashlib.sha256(f"{client_ip}:{salt}".encode("utf-8")).hexdigest()[:20]
            record_bot_session(
                session_type="telegram_login_challenge",
                telegram_id=None,
                username=payload.identifier or "",
                first_name="",
                client_ip_hash=ip_hash,
                status="pending",
                details_json=json.dumps({"challenge_id": res.get("challenge_id")}),
            )
        except Exception:
            pass
    return res


@app.get(
    "/api/auth/telegram/poll",
    tags=["Admin Authentication"],
    summary="Prüft, ob die Login-Anfrage in Telegram per 1-Klick-Button freigegeben wurde",
)
async def api_auth_telegram_poll(challenge_id: str = Query(..., min_length=8)):
    poll_res = admin_auth_manager.poll_challenge(challenge_id)
    if poll_res.get("status") == "approved":
        try:
            record_bot_session(
                session_type="telegram_login_challenge",
                status="approved",
                details_json=json.dumps({"challenge_id": challenge_id, "approved_by": poll_res.get("admin_label")}),
            )
        except Exception:
            pass
        resp = JSONResponse(
            content={
                "ok": True,
                "status": "approved",
                "redirect": "/admin",
            }
        )
        _set_admin_session_cookie(resp, admin_label=poll_res.get("admin_label", "telegram_admin"))
        return resp
    return {"ok": True, "status": poll_res.get("status", "pending")}


@app.post(
    "/api/auth/telegram/verify",
    tags=["Admin Authentication"],
    summary="Prüft den 6-stelligen Telegram Einmal-Code und setzt das Admin-Session-Cookie",
)
async def api_auth_telegram_verify(payload: TelegramLoginVerifyPayload):
    admin_label = admin_auth_manager.verify_code(
        code=payload.code,
        challenge_id=payload.challenge_id,
    )
    if not admin_label:
        raise HTTPException(
            status_code=401,
            detail="Ungültiger oder abgelaufener Einmal-Code. Bitte fordere einen neuen Code per Telegram (/login) an.",
        )

    resp = JSONResponse(
        content={
            "ok": True,
            "admin": admin_label,
            "redirect": "/admin",
        }
    )
    _set_admin_session_cookie(resp, admin_label=admin_label)
    return resp


# =====================================================================
# 1c. PUBLIC READ-ONLY API (FÜR DAS ÖFFENTLICHE USER-PANEL)
# =====================================================================

@app.get(
    "/api/public/overview",
    tags=["Public Panel API"],
    summary="Öffentliche Read-Only Übersicht für das User-Panel (ohne interne Logs/Whitelist)",
)
async def api_public_overview(period: str = Query("24h", description="all | today | 24h | 7d | 30d")):
    raw = await asyncio.to_thread(get_dashboard_overview, period=period)

    public_streamers = []
    for s in raw.get("streamers", []):
        uname = s["username"]
        public_streamers.append(
            {
                "id": s["id"],
                "username": uname,
                "display_name": s.get("display_name") or uname,
                "avatar_url": s.get("avatar_url") or "",
                "follower_count": s.get("follower_count") or 0,
                "current_viewers": s.get("current_viewers") or 0,
                "is_live": bool(s.get("is_live")),
                "is_tracking_active": monitor_manager.is_tracking(uname),
                "total_coins": s.get("total_coins") or 0,
                "gift_events_count": s.get("gift_events_count") or 0,
                "total_gifts_sent": s.get("total_gifts_sent") or 0,
                "unique_gifters": s.get("unique_gifters") or 0,
                "usd_net": s.get("usd_net") or 0.0,
                "eur_net": s.get("eur_net") or 0.0,
                "usd_gross": s.get("usd_gross") or 0.0,
                "eur_gross": s.get("eur_gross") or 0.0,
                "top_gift": s.get("top_gift"),
                "top_gifter": s.get("top_gifter"),
                "last_seen_at": s.get("last_seen_at"),
            }
        )

    cfg = raw.get("settings") or {}
    return {
        "period": raw.get("period", period),
        "totals": raw.get("totals", {}),
        "streamers": public_streamers,
        "recent_gifts": raw.get("recent_gifts", []),
        "rates": {
            "usd_per_diamond": cfg.get("usd_per_diamond", 0.005),
            "gross_usd_per_coin": cfg.get("gross_usd_per_coin", 0.0106),
            "usd_to_eur_rate": cfg.get("usd_to_eur_rate", 0.92),
        },
    }


@app.get(
    "/api/public/streamers/{identifier}",
    tags=["Public Panel API"],
    summary="Öffentliche Read-Only Detail-Auswertung eines Streamers",
)
async def api_public_streamer_detail(identifier: str, period: str = Query("24h")):
    init_db()
    s_row = get_streamer_by_id_or_username(identifier)
    if not s_row:
        raise HTTPException(status_code=404, detail="Streamer nicht gefunden")

    detail = get_streamer_detail(s_row["id"], period=period)
    if not detail:
        raise HTTPException(status_code=404, detail="Streamer nicht gefunden")

    s = detail["streamer"]
    uname = s["username"]
    return {
        "streamer": {
            "id": s["id"],
            "username": uname,
            "display_name": s.get("display_name") or uname,
            "avatar_url": s.get("avatar_url") or "",
            "follower_count": s.get("follower_count") or 0,
            "current_viewers": s.get("current_viewers") or 0,
            "is_live": bool(s.get("is_live")),
            "is_tracking_active": monitor_manager.is_tracking(uname),
        },
        "summary": detail.get("summary", {}),
        "gift_breakdown": detail.get("gift_breakdown", []),
        "top_gifters": detail.get("top_gifters", []),
        "sessions": detail.get("sessions", []),
    }


# =====================================================================
# TELEGRAM MINI-APP API (MOBILE-FIRST)
# =====================================================================

def consolidate_live_battles(
    raw_workers: List[Dict[str, Any]],
    streamer_map: Dict[Any, Any],
    filter_streamer_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """
    Konsolidiert aktive TikTok-Live-Battles aus den Workern.
    Erkennt interne Duelle (beide Duellanten getrackt) und fasst sie zu einer
    einheitlichen "Internes Derby"-Karte zusammen, anstatt zwei separate Karten anzuzeigen.
    """
    active_items = []
    for w in raw_workers:
        ab = w.get("active_battle")
        if not ab:
            continue
        uname = str(w.get("username") or "")
        s_id = w.get("streamer_id")
        s_info = streamer_map.get(s_id) or streamer_map.get(uname.lower()) or {}
        active_items.append({
            "streamer_id": s_id,
            "username": uname,
            "display_name": s_info.get("display_name") or uname,
            "avatar_url": s_info.get("avatar_url") or "",
            "battle": dict(ab),
        })

    consolidated = []
    merged_indices = set()

    for i, item1 in enumerate(active_items):
        if i in merged_indices:
            continue

        b1 = item1["battle"]
        b1_id = str(b1.get("battle_id") or "").strip()
        uname1 = item1["username"].lower()
        opp1 = str(b1.get("opponent_username") or "").lower()

        # Prüfen, ob ein anderer Worker dasselbe Battle hat
        partner_item = None
        for j, item2 in enumerate(active_items):
            if i == j or j in merged_indices:
                continue
            b2 = item2["battle"]
            b2_id = str(b2.get("battle_id") or "").strip()
            uname2 = item2["username"].lower()
            opp2 = str(b2.get("opponent_username") or "").lower()

            # Gleiche battle_id oder wechselseitige Gegner
            if (b1_id and b1_id == b2_id) or (uname1 and opp1 and uname1 == opp2 and uname2 == opp1):
                partner_item = item2
                merged_indices.add(j)
                break

        if partner_item:
            merged_indices.add(i)
            # Internes Duell zusammenführen
            s1_coins = b1.get("coins_earned", 0) or 0
            s2_coins = partner_item["battle"].get("coins_earned", 0) or 0
            s1_eur = float(b1.get("eur_net", 0.0) or 0.0)
            s2_eur = float(partner_item["battle"].get("eur_net", 0.0) or 0.0)
            tot_coins = s1_coins + s2_coins
            tot_eur = round(s1_eur + s2_eur, 2)

            score1 = b1.get("streamer_score", 0) or 0
            score2 = partner_item["battle"].get("streamer_score", 0) or 0

            # Reihenfolge bestimmen: Wenn Filter gesetzt, gefilterter Streamer nach links; sonst Führender nach links
            if filter_streamer_id and partner_item["streamer_id"] == filter_streamer_id:
                left_item = partner_item
                right_item = item1
                left_score = score2
                right_score = score1
                left_coins = s2_coins
                right_coins = s1_coins
                left_eur = s2_eur
                right_eur = s1_eur
            elif not filter_streamer_id and score2 > score1:
                left_item = partner_item
                right_item = item1
                left_score = score2
                right_score = score1
                left_coins = s2_coins
                right_coins = s1_coins
                left_eur = s2_eur
                right_eur = s1_eur
            else:
                left_item = item1
                right_item = partner_item
                left_score = score1
                right_score = score2
                left_coins = s1_coins
                right_coins = s2_coins
                left_eur = s1_eur
                right_eur = s2_eur

            streamer_a = {
                "id": left_item["streamer_id"],
                "username": left_item["username"],
                "display_name": left_item["display_name"],
                "avatar_url": left_item["avatar_url"],
                "score": left_score,
                "coins_earned": left_coins,
                "eur_net": left_eur,
            }
            streamer_b = {
                "id": right_item["streamer_id"],
                "username": right_item["username"],
                "display_name": right_item["display_name"],
                "avatar_url": right_item["avatar_url"],
                "score": right_score,
                "coins_earned": right_coins,
                "eur_net": right_eur,
            }

            merged_battle = dict(left_item["battle"])
            merged_battle["is_internal"] = True
            merged_battle["streamer_a"] = streamer_a
            merged_battle["streamer_b"] = streamer_b
            merged_battle["total_coins"] = tot_coins
            merged_battle["total_eur_net"] = tot_eur
            merged_battle["streamer_score"] = left_score
            merged_battle["opponent_score"] = right_score
            merged_battle["opponent_username"] = right_item["username"]
            merged_battle["opponent_display_name"] = right_item["display_name"]
            merged_battle["opponent_avatar_url"] = right_item["avatar_url"]
            merged_battle["coins_earned"] = tot_coins
            merged_battle["eur_net"] = tot_eur

            if filter_streamer_id:
                if left_item["streamer_id"] == filter_streamer_id or right_item["streamer_id"] == filter_streamer_id:
                    consolidated.append({
                        "streamer_id": left_item["streamer_id"],
                        "username": left_item["username"],
                        "display_name": left_item["display_name"],
                        "avatar_url": left_item["avatar_url"],
                        "battle": merged_battle,
                        "is_internal": True,
                    })
            else:
                consolidated.append({
                    "streamer_id": left_item["streamer_id"],
                    "username": left_item["username"],
                    "display_name": left_item["display_name"],
                    "avatar_url": left_item["avatar_url"],
                    "battle": merged_battle,
                    "is_internal": True,
                })
        else:
            # Normales Duell gegen externen Gegner
            if filter_streamer_id and item1["streamer_id"] != filter_streamer_id:
                continue
            item1["battle"]["is_internal"] = False
            consolidated.append(item1)

    return consolidated

@app.get(
    "/api/miniapp/data",
    tags=["Telegram Mini-App"],
    summary="Kompakter Daten-Feed für die Telegram Mini-App (Live-Matches, Einnahmen, Streamer)",
)
async def api_miniapp_data(period: str = Query("24h", description="today | 24h | 7d | 30d | all")):
    init_db()
    monitor_manager.autostart_from_db()

    # 1. Dashboard-Übersicht & Einnahmen
    overview = get_dashboard_overview(period=period)
    totals = overview.get("totals", {})
    totals["total_eur_net"] = totals.get("eur_net", 0.0)
    totals["total_usd_net"] = totals.get("usd_net", 0.0)
    cfg = overview.get("settings", {})

    # 2. Streamer-Liste
    streamers = []
    streamer_map = {}
    for s in overview.get("streamers", []):
        uname = s["username"]
        is_live = bool(s.get("is_live"))
        is_tracking = monitor_manager.is_tracking(uname)
        s_data = {
            "id": s["id"],
            "username": uname,
            "display_name": s.get("display_name") or uname,
            "avatar_url": s.get("avatar_url") or "",
            "is_live": is_live,
            "is_tracking": is_tracking,
            "current_viewers": s.get("current_viewers") or 0,
            "follower_count": s.get("follower_count") or 0,
            "total_coins": s.get("total_coins") or 0,
            "eur_net": s.get("eur_net") or 0.0,
            "usd_net": s.get("usd_net") or 0.0,
            "eur_gross": s.get("eur_gross") or 0.0,
            "gift_events_count": s.get("gift_events_count") or 0,
            "total_gifts_sent": s.get("total_gifts_sent") or 0,
            "last_seen_at": s.get("last_seen_at"),
        }
        streamers.append(s_data)
        streamer_map[s["id"]] = s_data
        streamer_map[uname.lower()] = s_data

    # Streamer sortieren: Erst LIVE, dann nach höchstem Umsatz
    streamers.sort(key=lambda x: (not x["is_live"], -x["eur_net"], -x["total_coins"]))

    # 3. Live aktive Battles aus den aktiven Workern (konsolidiert)
    diag = monitor_manager.get_all_diagnostics()
    live_battles = consolidate_live_battles(diag.get("workers", []), streamer_map)

    # 4. Kürzliche Battles
    battles_resp = get_battles_list(period=period, limit=25)
    recent_battles = battles_resp.get("battles", [])

    # 5. Battle Stats
    battle_stats = get_battle_stats(period=period)

    # 6. Telegram Bot Info
    tg_diag = telegram_bot_service.get_diagnostics()

    return {
        "period": period,
        "totals": totals,
        "live_battles": live_battles,
        "recent_battles": recent_battles,
        "streamers": streamers,
        "recent_gifts": overview.get("recent_gifts", [])[:15],
        "battle_stats": battle_stats,
        "rates": {
            "usd_per_diamond": cfg.get("usd_per_diamond", 0.005),
            "gross_usd_per_coin": cfg.get("gross_usd_per_coin", 0.0106),
            "usd_to_eur_rate": cfg.get("usd_to_eur_rate", 0.92),
        },
        "bot": {
            "username": tg_diag.get("bot_username") or "",
            "state": tg_diag.get("state") or "offline",
        },
    }


@app.get(
    "/api/miniapp/battles/{battle_id}",
    tags=["Telegram Mini-App"],
    summary="Detail-Informationen zu einem einzelnen Battle für die Mini-App",
)
async def api_miniapp_battle_detail(battle_id: int):
    init_db()
    battle = get_battle_details(battle_id)
    if not battle:
        raise HTTPException(status_code=404, detail="Battle nicht gefunden")
    return battle


@app.post(
    "/api/miniapp/auth",
    tags=["Telegram Mini-App"],
    summary="Authentifiziert den Telegram-Nutzer anhand von WebApp initData (HMAC-SHA256)",
)
async def api_miniapp_auth(payload: MiniAppAuthRequest, response: Response):
    init_db()
    validated = admin_auth_manager.validate_webapp_init_data(payload.init_data)
    if not validated:
        raise HTTPException(status_code=400, detail="Ungültige Telegram WebApp-Signatur")

    user = validated.get("user") or {}
    tg_id = user.get("id")
    username = user.get("username")
    first_name = user.get("first_name", "")

    # DB-Prüfung auf Whitelist-Status und Admin-Rolle
    if tg_id:
        access_check = check_telegram_user_access(
            telegram_id=int(tg_id),
            username=username,
            first_name=first_name,
            chat_id=int(tg_id),
        )
    else:
        access_check = {"allowed": False, "is_admin": False}

    is_whitelisted = bool(access_check.get("allowed", False))
    is_admin = bool(access_check.get("is_admin", False))
    if not is_admin and admin_auth_manager.is_admin_user(telegram_id=tg_id, username=username):
        is_admin = True
        is_whitelisted = True

    token = None
    user_label = f"tg_{tg_id}" if tg_id else f"tg_{username or 'user'}"
    if is_admin or is_whitelisted:
        token = admin_auth_manager.create_session_token(
            admin_label=user_label,
            role="admin" if is_admin else "user",
            is_allowed=is_whitelisted,
        )
        if is_admin:
            _set_admin_session_cookie(response, admin_label=user_label)

    try:
        record_bot_session(
            session_type="miniapp",
            telegram_id=tg_id,
            username=username or "",
            first_name=first_name or "",
            status="admin" if is_admin else ("whitelisted" if is_whitelisted else "user"),
            details_json=json.dumps({"is_admin": is_admin, "is_whitelisted": is_whitelisted}),
        )
    except Exception:
        pass

    return {
        "ok": True,
        "authenticated": True,
        "is_admin": is_admin,
        "is_whitelisted": is_whitelisted,
        "user": {
            "id": tg_id,
            "username": username,
            "first_name": first_name,
        },
        "token": token,
        "admin_label": user_label if (is_admin or is_whitelisted) else None,
    }


@app.get(
    "/api/miniapp/auth/status",
    tags=["Telegram Mini-App"],
    summary="Prüft den aktuellen Authentifizierungsstatus der Mini-App Session",
)
async def api_miniapp_auth_status(
    toktracker_admin_session: Optional[str] = Cookie(default=None),
    x_admin_session: Optional[str] = Header(default=None, alias="X-Admin-Session"),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
):
    token = toktracker_admin_session or x_admin_session
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    session_payload = admin_auth_manager.verify_session_token(token)
    if session_payload:
        role = session_payload.get("role", "admin")
        is_admin = (role == "admin")
        is_allowed = bool(session_payload.get("is_allowed", True))
        return {
            "authenticated": True,
            "is_admin": is_admin,
            "is_whitelisted": is_allowed or is_admin,
            "role": role,
            "admin_label": session_payload.get("sub", "admin"),
            "exp": session_payload.get("exp"),
        }
    is_public = (get_telegram_access_mode() == "public")
    return {
        "authenticated": False,
        "is_admin": False,
        "is_whitelisted": is_public,
        "admin_label": None,
    }


@app.get(
    "/api/miniapp/radar",
    tags=["Telegram Mini-App", "Spenderradar & Chatlog"],
    summary="Liefert aggregierte Daten für das Mini-App Spender-Radar (Whales, Sharks, Dolphins & Cross-Streamer)",
)
async def api_miniapp_radar(
    period: str = Query("24h", description="today | 24h | 7d | 30d | all"),
    min_tier: Optional[str] = Query(None, description="whale | shark | dolphin"),
    cross_only: bool = Query(False, description="Nur Cross-Streamer Spender"),
    vip_only: bool = Query(False, description="Nur VIP-Watchlist Spender"),
    streamer_id: Optional[int] = Query(None, description="Filter nach Streamer-ID"),
    search: Optional[str] = Query(None, description="Suchbegriff für Spender"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    toktracker_admin_session: Optional[str] = Cookie(default=None),
    x_admin_session: Optional[str] = Header(default=None, alias="X-Admin-Session"),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
):
    init_db()
    token = toktracker_admin_session or x_admin_session
    if not token and authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()

    is_authorized = False
    is_admin = False

    if token:
        payload = admin_auth_manager.verify_session_token(token)
        if payload:
            is_admin = (payload.get("role") == "admin")
            is_allowed = bool(payload.get("is_allowed", True))
            if is_admin or is_allowed:
                is_authorized = True

    if not is_authorized and get_telegram_access_mode() == "public":
        is_authorized = True

    if not is_authorized:
        return {
            "ok": False,
            "authorized": False,
            "error": "unauthorized",
            "message": "Dieser Bereich ist exklusiv für freigeschaltete Telegram-Nutzer verfügbar.",
            "kpis": {},
            "donors": [],
            "streamers": [],
        }

    radar_data = await asyncio.to_thread(
        get_donor_radar_data,
        period=period,
        min_tier=min_tier,
        streamer_id=streamer_id,
        cross_streamer_only=cross_only,
        vip_only=vip_only,
        search=search,
        limit=limit,
        offset=offset,
    )

    return {
        "ok": True,
        "authorized": True,
        "is_admin": is_admin,
        "period": period,
        "kpis": radar_data.get("kpis", {}),
        "donors": radar_data.get("donors", []),
        "streamers": radar_data.get("streamers", []),
        "total_donors": len(radar_data.get("donors", [])),
    }


@app.post(
    "/api/miniapp/auth/request_otp",
    tags=["Telegram Mini-App"],
    summary="Fordert einen 6-stelligen Login-Code an (Fallback für Webbrowser)",
)
async def api_miniapp_auth_request_otp(request: Request):
    init_db()
    client_host = request.client.host if request.client else "unbekannt"
    res = await telegram_bot_service.send_admin_login_challenge(
        identifier_hint=None,
        client_info=f"Mini-App Web ({client_host})",
    )
    return res


@app.post(
    "/api/miniapp/auth/verify_otp",
    tags=["Telegram Mini-App"],
    summary="Verifiziert den 6-stelligen OTP-Code oder das Notfall-Admin-Passwort",
)
async def api_miniapp_auth_verify_otp(payload: MiniAppVerifyCodeRequest, response: Response):
    admin_label = admin_auth_manager.verify_code(
        code=payload.code,
        challenge_id=payload.challenge_id,
    )
    if not admin_label:
        raise HTTPException(
            status_code=401,
            detail="Ungültiger oder abgelaufener Einmal-Code.",
        )
    token = admin_auth_manager.create_session_token(admin_label=admin_label)
    _set_admin_session_cookie(response, admin_label=admin_label)
    return {
        "ok": True,
        "authenticated": True,
        "is_admin": True,
        "admin_label": admin_label,
        "token": token,
    }


@app.post(
    "/api/miniapp/auth/logout",
    tags=["Telegram Mini-App"],
    summary="Beendet die Admin-Session in der Mini-App",
)
async def api_miniapp_auth_logout(response: Response):
    response.delete_cookie(key=AdminAuthManager.COOKIE_NAME, path="/")
    return {"ok": True, "message": "Erfolgreich abgemeldet"}


@app.get(
    "/api/miniapp/analytics",
    tags=["Telegram Mini-App"],
    summary="Öffentliche Analytics- und Chart-Daten für die Mini-App",
)
async def api_miniapp_analytics(
    period: str = Query("24h", description="all | today | 24h | 7d | 30d"),
    streamer_id: Optional[int] = Query(None, description="Optionaler Einzelfilter nach Streamer"),
):
    init_db()
    return get_analytics_data(streamer_id=streamer_id, period=period)


# =====================================================================
# 2. TELEGRAM-BOT SPEZIAL-ENDPOINTS (v1) – GESCHÜTZT DURCH ADMIN-AUTH ODER API-KEY
# =====================================================================

@app.get(
    "/api/v1/reports/daily",
    response_model=DailyBotReportResponse,
    tags=["Telegram Bot API"],
    summary="24h-Gesamtbericht über alle Streamer (für täglichen Telegram-Cronjob)",
    dependencies=[Depends(verify_admin_or_api_key)],
)
async def api_v1_daily_report(
    hours: int = Query(24, ge=1, le=720, description="Auswertungszeitraum in Stunden (Standard: 24h)"),
    only_active: bool = Query(False, description="Wenn True, nur Streamer mit Einnahmen > 0 im Zeitraum"),
):
    init_db()
    report_data = generate_full_report_data(hours=hours, only_active=only_active)
    return DailyBotReportResponse(**report_data)


@app.post(
    "/api/v1/telegram/send-report",
    tags=["Telegram Bot API"],
    summary="Sendet den 24h-Bericht sofort über den integrierten Telegram-Bot",
    dependencies=[Depends(verify_admin_or_api_key)],
)
async def api_v1_telegram_send_report(
    hours: int = Query(24, ge=1, le=720),
    chat_id: Optional[str] = Query(None, description="Optionale Ziel-Chat-ID (sonst TELEGRAM_CHAT_ID aus .env)"),
):
    init_db()
    res = await telegram_bot_service.send_report_now(chat_id=chat_id, hours=hours)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error", "Senden fehlgeschlagen"))
    return res


@app.get(
    "/api/telegram/users",
    tags=["Telegram Bot API"],
    summary="Listet alle Telegram-Nutzer (Whitelist, Admins & offene Anfragen) sowie den Zugriffsmodus",
    dependencies=[Depends(verify_admin_or_api_key)],
)
@app.get(
    "/api/v1/telegram/users",
    tags=["Telegram Bot API"],
    summary="Listet alle Telegram-Nutzer (Whitelist, Admins & offene Anfragen) sowie den Zugriffsmodus",
    dependencies=[Depends(verify_admin_or_api_key)],
)
async def api_get_telegram_users():
    init_db()
    return {
        "access_mode": get_telegram_access_mode(),
        "users": list_telegram_users(),
    }


@app.post(
    "/api/telegram/users",
    tags=["Telegram Bot API"],
    summary="Fügt einen Telegram-Nutzer per ID oder @username zur Whitelist hinzu oder ändert seine Rolle",
    dependencies=[Depends(verify_admin_or_api_key)],
)
@app.post(
    "/api/v1/telegram/users",
    tags=["Telegram Bot API"],
    summary="Fügt einen Telegram-Nutzer per ID oder @username zur Whitelist hinzu oder ändert seine Rolle",
    dependencies=[Depends(verify_admin_or_api_key)],
)
async def api_upsert_telegram_user(payload: TelegramUserPermissionRequest):
    init_db()
    try:
        user_row = upsert_telegram_user_permission(
            identifier=payload.identifier,
            is_allowed=payload.is_allowed,
            role=payload.role,
            first_name=payload.first_name,
            note=payload.note,
        )
        return {"ok": True, "user": user_row, "access_mode": get_telegram_access_mode()}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete(
    "/api/telegram/users/{record_id}",
    tags=["Telegram Bot API"],
    summary="Entfernt einen Telegram-Nutzer aus der Datenbank",
    dependencies=[Depends(verify_admin_or_api_key)],
)
@app.delete(
    "/api/v1/telegram/users/{record_id}",
    tags=["Telegram Bot API"],
    summary="Entfernt einen Telegram-Nutzer aus der Datenbank",
    dependencies=[Depends(verify_admin_or_api_key)],
)
async def api_delete_telegram_user(record_id: int):
    init_db()
    deleted = delete_telegram_user(record_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Telegram-Nutzer nicht gefunden.")
    return {"ok": True, "deleted_id": record_id}


@app.get(
    "/api/v1/streamers/{identifier}/report",
    response_model=StreamerReportCard,
    tags=["Telegram Bot API"],
    summary="Einzelabfrage für einen bestimmten Streamer per @username oder ID",
    dependencies=[Depends(verify_admin_or_api_key)],
)
async def api_v1_streamer_single_report(
    identifier: str,
    hours: int = Query(24, ge=1, le=8760, description="Zeitraum in Stunden für die Auswertung (Standard: 24h)"),
):
    init_db()
    streamer = get_streamer_by_id_or_username(identifier)
    if not streamer:
        raise HTTPException(
            status_code=404,
            detail=f"Streamer '{identifier}' wurde nicht in der Datenbank gefunden.",
        )
    return _enrich_streamer_card(streamer, hours=hours)


# =====================================================================
# 3. ADMIN BACKEND- & MANAGEMENT-ENDPOINTS (GESCHÜTZT)
# =====================================================================

@app.get("/api/overview", tags=["Dashboard & Data"], dependencies=[Depends(verify_admin_or_api_key)])
@app.get("/api/v1/overview", tags=["Telegram Bot API"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_overview(period: str = Query("all", description="all | today | 24h | 7d | 30d")):
    data = await asyncio.to_thread(get_dashboard_overview, period=period)
    for s in data["streamers"]:
        uname = s["username"]
        s["is_tracking_active"] = monitor_manager.is_tracking(uname)
        s["monitor_status"] = monitor_manager.get_status(uname)
        s["worker_diagnostics"] = monitor_manager.get_worker_diagnostics(uname)
    sys_diag = monitor_manager.get_all_diagnostics()
    sys_diag["telegram_bot"] = telegram_bot_service.get_diagnostics()
    data["system"] = sys_diag
    data["gift_catalog"] = TIKTOK_GIFT_CATALOG
    return data


@app.get("/api/analytics", tags=["Dashboard & Data"], dependencies=[Depends(verify_admin_or_api_key)])
@app.get("/api/v1/analytics", tags=["Dashboard & Data"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_analytics(
    streamer_id: Optional[int] = Query(None, description="Optionale Streamer-ID für Einzelanalyse (sonst alle Streamer)"),
    period: str = Query("all", description="all | today | 24h | 7d | 30d"),
):
    return await asyncio.to_thread(get_analytics_data, streamer_id=streamer_id, period=period)


@app.get(
    "/api/site-analytics",
    tags=["Site & Bot Analytics"],
    summary="Liefert aggregierte Daten zu Web-Traffic, Besuchern und Bot-Sessions",
    dependencies=[Depends(verify_admin_or_api_key)],
)
@app.get(
    "/api/v1/site-analytics",
    tags=["Site & Bot Analytics"],
    summary="Liefert aggregierte Daten zu Web-Traffic, Besuchern und Bot-Sessions",
    dependencies=[Depends(verify_admin_or_api_key)],
)
async def api_site_analytics(
    period: str = Query("today", description="all | today | 24h | 7d | 30d"),
):
    init_db()
    data = get_site_analytics_overview(period=period)
    overview = get_dashboard_overview(period=period)
    workers_list = []
    for s in overview.get("streamers", []):
        uname = s["username"]
        diag = monitor_manager.get_worker_diagnostics(uname)
        status = monitor_manager.get_status(uname)
        workers_list.append({
            "id": s["id"],
            "username": uname,
            "display_name": s.get("display_name") or uname,
            "avatar_url": s.get("avatar_url"),
            "is_live": s.get("is_live", 0),
            "is_monitoring": monitor_manager.is_tracking(uname),
            "status": status,
            "connected_since": diag.get("connected_since") if diag else None,
            "total_diamonds": s.get("total_diamonds", 0),
            "gifts_received_session": diag.get("gifts_received_session", 0) if diag else 0,
            "reconnect_count": diag.get("reconnect_attempts", 0) if diag else 0,
            "last_seen_live": s.get("last_seen_live"),
            "last_error": diag.get("last_error") if diag else (s.get("last_error") or ""),
        })
    data["tiktok_workers"] = workers_list
    data["recent_challenges"] = admin_auth_manager.get_recent_challenges(limit=25)
    data["telegram_diagnostics"] = telegram_bot_service.get_diagnostics()
    return data



@app.get(
    "/api/donor-radar",
    tags=["Spenderradar & Chatlog"],
    summary="Liefert aggregierte Daten für das Spender-Radar (Whales, Sharks, Dolphins & Cross-Streamer)",
    dependencies=[Depends(verify_radar_access)],
)
@app.get(
    "/api/v1/donor-radar",
    tags=["Spenderradar & Chatlog"],
    summary="Liefert aggregierte Daten für das Spender-Radar (Whales, Sharks, Dolphins & Cross-Streamer)",
    dependencies=[Depends(verify_radar_access)],
)
async def api_donor_radar(
    period: str = Query("all", description="all | today | 24h | 7d | 30d"),
    min_tier: Optional[str] = Query(None, description="whale | shark | dolphin"),
    streamer_id: Optional[int] = Query(None, description="Filter nach Streamer-ID"),
    cross_streamer_only: bool = Query(False, description="Nur Spender mit >= 2 Streamern anzeigen"),
    vip_only: bool = Query(False, description="Nur Spender auf der VIP-Watchlist anzeigen"),
    search: Optional[str] = Query(None, description="Suchbegriff für Username / Nickname"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    init_db()
    data = await asyncio.to_thread(
        get_donor_radar_data,
        period=period,
        min_tier=min_tier,
        streamer_id=streamer_id,
        cross_streamer_only=cross_streamer_only,
        vip_only=vip_only,
        search=search,
        limit=limit,
        offset=offset,
    )
    return {"ok": True, "data": data}


@app.get(
    "/api/donor-radar/donors/{username}",
    tags=["Spenderradar & Chatlog"],
    summary="Liefert ein detailliertes Spender-Dossier inkl. Streamer-Verteilung, Top-Gifts und Chat-Historie",
    dependencies=[Depends(verify_radar_access)],
)
@app.get(
    "/api/v1/donor-radar/donors/{username}",
    tags=["Spenderradar & Chatlog"],
    summary="Liefert ein detailliertes Spender-Dossier inkl. Streamer-Verteilung, Top-Gifts und Chat-Historie",
    dependencies=[Depends(verify_radar_access)],
)
async def api_donor_detail(username: str):
    init_db()
    details = await asyncio.to_thread(get_donor_details, username)
    if not details:
        raise HTTPException(status_code=404, detail="Spender nicht gefunden")
    return {"ok": True, "data": details}


@app.post(
    "/api/donor-radar/donors/{username}/crm",
    tags=["Spenderradar & Chatlog"],
    summary="Aktualisiert VIP-Status, Tags und Notizen für einen Spender",
    dependencies=[Depends(verify_radar_access)],
)
@app.post(
    "/api/v1/donor-radar/donors/{username}/crm",
    tags=["Spenderradar & Chatlog"],
    summary="Aktualisiert VIP-Status, Tags und Notizen für einen Spender",
    dependencies=[Depends(verify_radar_access)],
)
async def api_update_donor_crm(username: str, req: DonorCRMUpdateRequest):
    init_db()
    res = await asyncio.to_thread(
        save_donor_crm,
        username=username,
        is_vip=req.is_vip,
        tags=req.tags,
        notes=req.notes,
    )
    return {"ok": True, "data": res}


@app.post(
    "/api/donor-radar/donors/{username}/toggle-vip",
    tags=["Spenderradar & Chatlog"],
    summary="Schaltet den VIP-Watchlist-Status eines Spenders um",
    dependencies=[Depends(verify_radar_access)],
)
@app.post(
    "/api/v1/donor-radar/donors/{username}/toggle-vip",
    tags=["Spenderradar & Chatlog"],
    summary="Schaltet den VIP-Watchlist-Status eines Spenders um",
    dependencies=[Depends(verify_radar_access)],
)
async def api_toggle_donor_vip(username: str):
    init_db()
    res = await asyncio.to_thread(toggle_donor_vip, username)
    return {"ok": True, "data": res}


@app.get(
    "/api/donor-radar/whale-alerts",
    tags=["Spenderradar & Chatlog"],
    summary="Liefert Echtzeit-Großspenden (Whale- & Shark-Events) für Live-Ticker und Audio-Alerts",
    dependencies=[Depends(verify_radar_access)],
)
@app.get(
    "/api/v1/donor-radar/whale-alerts",
    tags=["Spenderradar & Chatlog"],
    summary="Liefert Echtzeit-Großspenden (Whale- & Shark-Events) für Live-Ticker und Audio-Alerts",
    dependencies=[Depends(verify_radar_access)],
)
async def api_whale_alerts(
    min_coins: int = Query(1000, ge=50, le=100000, description="Mindestanzahl Coins für den Whale-Alert"),
    after_id: Optional[int] = Query(None, description="Nur Geschenke mit ID > after_id abrufen"),
    limit: int = Query(20, ge=1, le=100),
):
    init_db()
    alerts = await asyncio.to_thread(
        get_recent_whale_gifts,
        min_coins=min_coins,
        after_id=after_id,
        limit=limit,
    )
    return {"ok": True, "alerts": alerts}


@app.get(
    "/api/donor-radar/loyalty-and-overlap",
    tags=["Spenderradar & Chatlog"],
    summary="Liefert netzwerkweite Frontenwechsler-Analyse und Streamer-Überschneidungsmatrix",
    dependencies=[Depends(verify_radar_access)],
)
@app.get(
    "/api/v1/donor-radar/loyalty-and-overlap",
    tags=["Spenderradar & Chatlog"],
    summary="Liefert netzwerkweite Frontenwechsler-Analyse und Streamer-Überschneidungsmatrix",
    dependencies=[Depends(verify_radar_access)],
)
async def api_loyalty_and_overlap(
    min_coins: int = Query(50, ge=1, description="Mindestmünzen für Frontenwechsler"),
    days_recent: int = Query(14, ge=1, le=90, description="Zeitfenster für die aktuelle Periode in Tagen"),
):
    init_db()
    data = await asyncio.to_thread(
        get_network_loyalty_and_overlap,
        min_coins=min_coins,
        days_recent=days_recent,
    )
    return {"ok": True, "data": data}


@app.get(
    "/api/chat-logs",
    tags=["Spenderradar & Chatlog"],
    summary="Liefert Live- und historische Chatlogs pro Streamer oder global",
    dependencies=[Depends(verify_radar_access)],
)
@app.get(
    "/api/v1/chat-logs",
    tags=["Spenderradar & Chatlog"],
    summary="Liefert Live- und historische Chatlogs pro Streamer oder global",
    dependencies=[Depends(verify_radar_access)],
)
async def api_chat_logs(
    streamer_id: Optional[int] = Query(None, description="Filter nach Streamer-ID"),
    search: Optional[str] = Query(None, description="Textsuche in Chat-Nachrichten"),
    min_tier: Optional[str] = Query(None, description="whale | shark | dolphin"),
    only_whales: bool = Query(False, description="Nur Spender-Nachrichten anzeigen"),
    before_id: Optional[int] = Query(None, description="Ältere Nachrichten abrufen (Paginierung)"),
    after_id: Optional[int] = Query(None, description="Neuere Nachrichten abrufen (Live-Polling)"),
    limit: int = Query(100, ge=1, le=500),
):
    init_db()
    messages = await asyncio.to_thread(
        get_chat_messages,
        streamer_id=streamer_id,
        limit=limit,
        search=search,
        min_tier=min_tier,
        only_whales=only_whales,
        before_id=before_id,
        after_id=after_id,
    )
    return {"ok": True, "messages": messages, "count": len(messages)}



@app.get("/api/battles", tags=["TikTok Battles"], dependencies=[Depends(verify_admin_or_api_key)])
@app.get("/api/v1/battles", tags=["TikTok Battles"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_get_battles(
    streamer_id: Optional[int] = Query(None, description="Streamer-ID"),
    period: str = Query("all", description="all | today | 24h | 7d | 30d"),
    result: Optional[str] = Query(None, description="WIN | LOSE | DRAW | ONGOING"),
    mode: Optional[str] = Query(None, description="1v1 | 2v2"),
    search: Optional[str] = Query(None, description="Suche nach Gegner-Name"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    init_db()
    monitor_manager.autostart_from_db()
    data = get_battles_list(
        streamer_id=streamer_id,
        period=period,
        result_filter=result,
        mode_filter=mode,
        search=search,
        limit=limit,
        offset=offset,
    )
    # Laufende Battles aus aktiven Workern erfassen (konsolidiert)
    diag = monitor_manager.get_all_diagnostics()
    streamers_summary = {s["id"]: s for s in get_streamers_summary()}
    data["live_active_battles"] = consolidate_live_battles(
        diag.get("workers", []),
        streamers_summary,
        filter_streamer_id=streamer_id,
    )
    return data


@app.get("/api/battles/stats", tags=["TikTok Battles"], dependencies=[Depends(verify_admin_or_api_key)])
@app.get("/api/v1/battles/stats", tags=["TikTok Battles"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_get_battle_stats(
    streamer_id: Optional[int] = Query(None, description="Streamer-ID"),
    period: str = Query("all", description="all | today | 24h | 7d | 30d"),
):
    init_db()
    monitor_manager.autostart_from_db()
    return get_battle_stats(streamer_id=streamer_id, period=period)


@app.get("/api/battles/{battle_id}", tags=["TikTok Battles"], dependencies=[Depends(verify_admin_or_api_key)])
@app.get("/api/v1/battles/{battle_id}", tags=["TikTok Battles"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_get_battle_detail(battle_id: int):
    init_db()
    battle = get_battle_details(battle_id)
    if not battle:
        raise HTTPException(status_code=404, detail="Battle nicht gefunden")
    return battle


@app.get("/api/system/status", tags=["System & Workers"], dependencies=[Depends(verify_admin_or_api_key)])
@app.get("/api/v1/system/status", tags=["System & Workers"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_system_status():
    diag = monitor_manager.get_all_diagnostics()
    diag["telegram_bot"] = telegram_bot_service.get_diagnostics()
    diag["system_health"] = get_system_health()
    return diag


@app.get("/api/system/health", tags=["System & Workers"], dependencies=[Depends(verify_admin_or_api_key)])
@app.get("/api/v1/system/health", tags=["System & Workers"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_system_health(force_refresh: bool = False):
    return get_system_health(force_refresh=force_refresh)


@app.get("/api/streamers/{identifier}", tags=["Dashboard & Data"], dependencies=[Depends(verify_admin_or_api_key)])
@app.get("/api/v1/streamers/{identifier}", tags=["Telegram Bot API"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_streamer_detail(identifier: str, period: str = Query("all")):
    init_db()
    s_row = get_streamer_by_id_or_username(identifier)
    if not s_row:
        raise HTTPException(status_code=404, detail="Streamer nicht gefunden")

    detail = get_streamer_detail(s_row["id"], period=period)
    if not detail:
        raise HTTPException(status_code=404, detail="Streamer nicht gefunden")

    uname = detail["streamer"]["username"]
    detail["streamer"]["is_tracking_active"] = monitor_manager.is_tracking(uname)
    detail["streamer"]["monitor_status"] = monitor_manager.get_status(uname)
    detail["streamer"]["worker_diagnostics"] = monitor_manager.get_worker_diagnostics(uname)
    return detail


@app.post("/api/streamers", tags=["Dashboard & Data"], dependencies=[Depends(verify_admin_or_api_key)])
@app.post("/api/v1/streamers", tags=["Telegram Bot API"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_add_streamer(payload: StreamerCreateRequest):
    init_db()
    username = payload.username.strip().lstrip("@").lower()
    if not username:
        raise HTTPException(status_code=400, detail="Bitte einen gültigen TikTok @username eingeben.")

    profile = fetch_tiktok_user_info(username)
    display_name = payload.display_name or profile.get("display_name") or username

    streamer = upsert_streamer(
        username=username,
        display_name=display_name,
        avatar_url=profile.get("avatar_url"),
        room_id=profile.get("room_id"),
        follower_count=profile.get("follower_count"),
        is_live=profile.get("is_live"),
        auto_monitor=payload.auto_track and payload.auto_reconnect,
    )

    track_info = None
    if payload.auto_track:
        track_info = monitor_manager.start_tracking(
            streamer["id"], streamer["username"], auto_reconnect=payload.auto_reconnect
        )

    return {
        "ok": True,
        "streamer": streamer,
        "profile_fetched": profile,
        "tracking": track_info,
    }


@app.post("/api/streamers/{identifier}/refresh", tags=["Dashboard & Data"], dependencies=[Depends(verify_admin_or_api_key)])
@app.post("/api/v1/streamers/{identifier}/refresh", tags=["Telegram Bot API"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_refresh_streamer(identifier: str):
    init_db()
    row = get_streamer_by_id_or_username(identifier)
    if not row:
        raise HTTPException(status_code=404, detail="Streamer nicht gefunden")

    profile = fetch_tiktok_user_info(row["username"])
    updated = upsert_streamer(
        username=row["username"],
        display_name=profile.get("display_name") or row["display_name"],
        avatar_url=profile.get("avatar_url") or row["avatar_url"],
        room_id=profile.get("room_id"),
        follower_count=profile.get("follower_count") or row["follower_count"],
        is_live=profile.get("is_live"),
    )
    return {"ok": True, "streamer": updated, "profile": profile}


@app.post("/api/streamers/{identifier}/track", tags=["Dashboard & Data"], dependencies=[Depends(verify_admin_or_api_key)])
@app.post("/api/v1/streamers/{identifier}/track", tags=["Telegram Bot API"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_toggle_tracking(identifier: str, payload: Optional[TrackActionRequest] = None):
    init_db()
    req = payload or TrackActionRequest()
    row = get_streamer_by_id_or_username(identifier)
    if not row:
        raise HTTPException(status_code=404, detail="Streamer nicht gefunden")

    username = row["username"]
    currently_tracking = monitor_manager.is_tracking(username)

    if req.action == "stop" or (req.action == "toggle" and currently_tracking):
        return monitor_manager.stop_tracking(username)
    return monitor_manager.start_tracking(
        row["id"], username, auto_reconnect=req.auto_reconnect
    )


@app.delete("/api/streamers/{identifier}", tags=["Dashboard & Data"], dependencies=[Depends(verify_admin_or_api_key)])
@app.delete("/api/v1/streamers/{identifier}", tags=["Telegram Bot API"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_delete_streamer(identifier: str):
    init_db()
    row = get_streamer_by_id_or_username(identifier)
    if not row:
        raise HTTPException(status_code=404, detail="Streamer nicht gefunden")

    monitor_manager.stop_tracking(row["username"])
    delete_streamer(row["id"])
    return {"ok": True, "deleted_username": row["username"]}


@app.post("/api/gifts", tags=["Dashboard & Data"], dependencies=[Depends(verify_admin_or_api_key)])
@app.post("/api/v1/gifts", tags=["Telegram Bot API"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_record_gift(payload: GiftCreateRequest):
    init_db()
    streamer_id = payload.streamer_id
    if not streamer_id and payload.username:
        s = upsert_streamer(username=payload.username)
        streamer_id = s["id"]

    if not streamer_id:
        raise HTTPException(status_code=400, detail="streamer_id oder username erforderlich.")

    sender_username = payload.sender_username.strip().lstrip("@") or "live_viewer"
    sender_nickname = (payload.sender_nickname or sender_username).strip()

    event, created = record_gift_event(
        streamer_id=int(streamer_id),
        sender_username=sender_username,
        sender_nickname=sender_nickname,
        gift_name=payload.gift_name.strip(),
        diamond_count=payload.diamond_count,
        repeat_count=payload.repeat_count,
        source=payload.source,
    )
    return {"ok": True, "created": created, "event": event}


@app.get("/api/export/gifts.csv", tags=["Dashboard & Data"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_export_gifts_csv(streamer_id: Optional[int] = Query(None)):
    init_db()
    with get_db() as conn:
        if streamer_id:
            rows = conn.execute(
                """
                SELECT g.*, s.username AS streamer_username
                FROM gift_events g
                JOIN streamers s ON s.id = g.streamer_id
                WHERE g.streamer_id = ?
                ORDER BY g.created_at DESC
                """,
                (streamer_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT g.*, s.username AS streamer_username
                FROM gift_events g
                JOIN streamers s ON s.id = g.streamer_id
                ORDER BY g.created_at DESC
                """
            ).fetchall()

    output = io.StringIO()
    writer = csv.writer(output, delimiter=";")
    writer.writerow(
        [
            "id",
            "created_at",
            "streamer_username",
            "session_id",
            "sender_username",
            "sender_nickname",
            "is_super_fan",
            "gift_id",
            "gift_name",
            "diamond_count",
            "repeat_count",
            "total_coins",
            "usd_net",
            "eur_net",
            "usd_gross",
            "eur_gross",
            "source",
        ]
    )
    for r in rows:
        writer.writerow(
            [
                r["id"],
                r["created_at"],
                r["streamer_username"],
                r["session_id"],
                r["sender_username"],
                r["sender_nickname"],
                r["is_super_fan"],
                r["gift_id"],
                r["gift_name"],
                r["diamond_count"],
                r["repeat_count"],
                r["total_coins"],
                r["usd_net"],
                r["eur_net"],
                r["usd_gross"],
                r["eur_gross"],
                r["source"],
            ]
        )

    return Response(
        content=output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=toktracker_gifts_export.csv"},
    )


@app.get("/api/export/battles.csv", tags=["TikTok Battles"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_export_battles_csv(streamer_id: Optional[int] = Query(None)):
    init_db()
    with get_db() as conn:
        if streamer_id:
            rows = conn.execute(
                """
                SELECT b.*, s.username AS streamer_username
                FROM tiktok_battles b
                JOIN streamers s ON s.id = b.streamer_id
                WHERE b.streamer_id = ?
                ORDER BY b.started_at DESC
                """,
                (streamer_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT b.*, s.username AS streamer_username
                FROM tiktok_battles b
                JOIN streamers s ON s.id = b.streamer_id
                ORDER BY b.started_at DESC
                """
            ).fetchall()

    output = io.StringIO()
    writer = csv.writer(output, delimiter=";")
    writer.writerow(
        [
            "id",
            "battle_id",
            "battle_mode",
            "streamer_username",
            "streamer_score",
            "teammate_username",
            "teammate_score",
            "opponent_username",
            "opponent_display_name",
            "opponent_score",
            "opponent2_username",
            "opponent2_score",
            "opponent3_username",
            "opponent3_score",
            "streamer_rank",
            "started_at",
            "ended_at",
            "duration_seconds",
            "result",
            "streamer_mvp_name",
            "streamer_mvp_score",
            "opponent_mvp_name",
            "opponent_mvp_score",
            "coins_earned",
            "eur_net",
            "usd_net",
            "status",
        ]
    )
    for r in rows:
        writer.writerow(
            [
                r["id"],
                r["battle_id"],
                r["battle_mode"] or "1v1",
                r["streamer_username"],
                r["streamer_score"],
                r["teammate_username"] or "",
                r["teammate_score"] or 0,
                r["opponent_username"],
                r["opponent_display_name"],
                r["opponent_score"],
                r["opponent2_username"] or "",
                r["opponent2_score"] or 0,
                r["opponent3_username"] or "",
                r["opponent3_score"] or 0,
                r["streamer_rank"] or 0,
                r["started_at"],
                r["ended_at"] or "",
                r["duration_seconds"],
                r["result"],
                r["streamer_mvp_name"] or "",
                r["streamer_mvp_score"] or 0,
                r["opponent_mvp_name"] or "",
                r["opponent_mvp_score"] or 0,
                r["coins_earned"] or 0,
                r["eur_net"] or 0.0,
                r["usd_net"] or 0.0,
                r["status"],
            ]
        )

    return Response(
        content=output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=tiktok_battles_export.csv"},
    )


@app.get("/api/settings", tags=["System & Workers"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_get_settings():
    init_db()
    return get_settings()


@app.post("/api/settings", tags=["System & Workers"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_update_settings(payload: SettingsUpdateRequest):
    init_db()
    updated = update_settings(payload.model_dump(exclude_none=True))
    return {"ok": True, "settings": updated}


@app.post("/api/demo/seed", tags=["Dashboard & Data"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_seed_demo():
    init_db()
    seed_demo_data()
    return {"ok": True, "message": "Demo-Daten geladen."}


@app.post("/api/demo/clear", tags=["Dashboard & Data"], dependencies=[Depends(verify_admin_or_api_key)])
async def api_clear_demo():
    init_db()
    removed = clear_demo_data()
    return {"ok": True, "removed": removed}


# =====================================================================
# SQLITE DATENBANK IMPORTER (ADMIN PANEL API)
# =====================================================================

@app.get(
    "/api/admin/sqlite/inspect",
    tags=["System & Workers"],
    summary="Untersucht eine SQLite-Datei vor dem Import (Standard: tiktok_earnings.db)",
    dependencies=[Depends(verify_admin_or_api_key)],
)
async def api_sqlite_inspect(file_path: Optional[str] = Query(None)):
    target_path = file_path.strip() if file_path and file_path.strip() else config.db_path
    if not os.path.exists(target_path):
        raise HTTPException(
            status_code=404,
            detail=f"SQLite-Datei '{target_path}' wurde auf dem Server nicht gefunden."
        )
    try:
        inspection = inspect_sqlite_database(target_path)
        # Zusätzliche Info über aktuelle Ziel-Datenbank
        inspection["target_db"] = {
            "engine": config.db_engine,
            "target": (
                f"{config.mysql_user}@{config.mysql_host}:{config.mysql_port}/{config.mysql_database}"
                if config.is_mysql
                else os.path.basename(config.db_path)
            ),
        }
        return {"ok": True, "data": inspection}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Fehler bei der Analyse: {exc}")


@app.post(
    "/api/admin/sqlite/import",
    tags=["System & Workers"],
    summary="Führt den Datenimport aus der SQLite-Datei in die aktive Datenbank aus",
    dependencies=[Depends(verify_admin_or_api_key)],
)
async def api_sqlite_import(payload: Optional[SqliteImportRequest] = None):
    init_db()
    req = payload or SqliteImportRequest()
    target_path = (req.file_path or "").strip() or config.db_path
    if not os.path.exists(target_path):
        raise HTTPException(
            status_code=404,
            detail=f"SQLite-Datei '{target_path}' wurde auf dem Server nicht gefunden."
        )

    try:
        result = import_from_sqlite_database(
            sqlite_file_path=target_path,
            import_tables=req.tables,
            mode=req.mode,
        )
        # Nach dem Import auto-start für neu importierte Streamer triggern
        try:
            monitor_manager.autostart_from_db(force=True)
        except Exception:
            pass
        return {"ok": True, "result": result}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Fehler beim Importieren: {exc}")


if __name__ == "__main__":
    uvicorn.run("app:app", host=config.app_host, port=config.app_port, reload=False)
