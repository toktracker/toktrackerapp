from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class StreamerCreateRequest(BaseModel):
    username: str = Field(..., description="TikTok @username (mit oder ohne @)")
    display_name: Optional[str] = Field(None, description="Optionaler Anzeigename")
    auto_track: bool = Field(True, description="Startet sofort den Hintergrund-Worker für diesen Streamer")
    auto_reconnect: bool = Field(True, description="Überwacht den Streamer dauerhaft (Auto-Polling wenn offline)")


class TrackActionRequest(BaseModel):
    action: str = Field("toggle", description="'start', 'stop' oder 'toggle'")
    auto_reconnect: bool = Field(True, description="Ob der Worker bei Offline-Status weiter pollen soll")


class GiftCreateRequest(BaseModel):
    streamer_id: Optional[int] = Field(None, description="Interne Streamer-ID (alternativ username angeben)")
    username: Optional[str] = Field(None, description="TikTok @username des Streamers")
    gift_name: str = Field("Rose", description="Name des TikTok-Geschenks")
    diamond_count: int = Field(1, ge=1, description="Coin-/Diamond-Wert pro einzelnem Geschenk")
    repeat_count: int = Field(1, ge=1, description="Anzahl (Combo/Streak)")
    sender_username: str = Field("live_viewer", description="@username des Spenders")
    sender_nickname: Optional[str] = Field(None, description="Anzeigename des Spenders")
    source: str = Field("manual", description="Quelle des Eintrags (manual, webhook, tiktoklive)")


class SettingsUpdateRequest(BaseModel):
    usd_per_diamond: Optional[float] = Field(None, gt=0, description="Netto-Auszahlung in USD pro Coin/Diamond")
    gross_usd_per_coin: Optional[float] = Field(None, gt=0, description="Brutto-Zuschauerkaufpreis in USD pro Coin")
    usd_to_eur_rate: Optional[float] = Field(None, gt=0, description="Wechselkurs USD zu EUR")
    currency_primary: Optional[str] = Field(None, description="'EUR' oder 'USD'")
    poll_interval_seconds: Optional[int] = Field(None, ge=15, description="Polling-Intervall in Sekunden für Offline-Streamer")
    api_key: Optional[str] = Field(None, description="Optionaler API-Key für externe Bot-Zugriffe (leer = deaktiviert)")
    telegram_access_mode: Optional[str] = Field(
        None,
        description="Telegram-Bot Zugriffsmodus: 'whitelist' (nur freigeschaltete Personen) oder 'public' (alle Nutzer)",
    )


class TelegramUserPermissionRequest(BaseModel):
    identifier: str = Field(
        ...,
        description="Telegram User-ID oder @username",
    )
    role: str = Field("user", description="Rolle: 'user' (Lesezugriff) oder 'admin' (Vollzugriff)")
    is_allowed: int = Field(
        1,
        description="1 = Freigeschaltet, 0 = Wartend/Entzogen, -1 = Gesperrt (auch im Public-Modus blockiert)",
    )
    first_name: Optional[str] = Field(None, description="Optionaler Name / Beschreibung")
    note: Optional[str] = Field(None, description="Optionale Notiz")


class GiftStatItem(BaseModel):
    gift_name: str
    diamond_count: int = 0
    total_quantity: int
    total_coins: int
    events_count: int = 0
    usd_net: float
    eur_net: float


class GifterStatItem(BaseModel):
    sender_username: str
    sender_nickname: str
    is_super_fan: bool = False
    total_coins: int
    gifts_sent: int
    transactions: int = 1
    usd_net: float
    eur_net: float


class StreamerReportCard(BaseModel):
    streamer_id: int
    username: str
    display_name: str
    is_live: bool
    is_tracking_active: bool
    worker_state: str
    current_viewers: int
    follower_count: int
    # Zeitraum-Werte (z.B. letzte 24h)
    period_hours: int
    period_coins: int
    period_gifts_sent: int
    period_gift_events: int
    period_unique_gifters: int
    period_usd_net: float
    period_eur_net: float
    period_usd_gross: float
    period_eur_gross: float
    period_sessions_count: int
    period_peak_viewers: int
    # All-Time Vergleichswerte
    alltime_coins: int
    alltime_usd_net: float
    alltime_eur_net: float
    # Top-Listen im Zeitraum
    top_gifts: List[GiftStatItem] = []
    top_gifters: List[GifterStatItem] = []
    # Vorformatierter Text für Telegram-Nachrichten
    telegram_text: str


class DailyBotReportResponse(BaseModel):
    generated_at: str
    period_hours: int
    cutoff_timestamp: str
    currency_primary: str
    totals: Dict[str, Any]
    streamers: List[StreamerReportCard]
    telegram_markdown: str
    telegram_html: str


class SqliteImportRequest(BaseModel):
    file_path: Optional[str] = None
    tables: Optional[List[str]] = None
    mode: str = "merge"  # "merge" oder "clean"


class MiniAppAuthRequest(BaseModel):
    init_data: str = Field(..., description="Raw window.Telegram.WebApp.initData query string")


class MiniAppVerifyCodeRequest(BaseModel):
    code: str = Field(..., min_length=4, max_length=64, description="6-stelliger OTP-Code oder Admin-Passwort")
    challenge_id: Optional[str] = Field(None, description="Optionale Challenge ID")


class DonorCRMUpdateRequest(BaseModel):
    is_vip: Optional[bool] = Field(None, description="VIP / Watchlist-Status")
    tags: Optional[List[str]] = Field(None, description="Liste von Tags / Labels")
    notes: Optional[str] = Field(None, description="Interne Admin-Notizen zum Spender")

