"""
migrate_sqlite_to_mysql.py
--------------------------
Migriert alle bestehenden Daten aus der lokalen SQLite-Datenbank (tiktok_earnings.db)
in den MariaDB / MySQL Server (lokal, auf dem Server oder im Docker-Container).

Zugangsdaten-Priorität:
1. Explizit übergebene CLI-Argumente (--host, --user, --password, etc.)
2. Werte aus der vorhandenen .env-Datei
3. Fallback-Standardwerte aus .env.example:
   - Host: db (im Docker-Netzwerk) bzw. 127.0.0.1 (vom Host aus)
   - Port: 3306
   - User: toktracker_user
   - Password: user_change_me_in_production
   - Database: toktracker

Verwendung:
  # 1. Automatisch (nutzt .env oder .env.example Defaults):
  python migrate_sqlite_to_mysql.py

  # 2. Mit expliziten Parametern:
  python migrate_sqlite_to_mysql.py --host 127.0.0.1 --port 3306 --user toktracker_user --password "user_change_me_in_production" --database toktracker

  # 3. Direkt im Docker-Container auf dem Server:
  docker compose exec app python migrate_sqlite_to_mysql.py
"""

import argparse
import os
import re
import sqlite3
import sys
from typing import Optional

from config import config
from database import (
    PYMYSQL_AVAILABLE,
    MySQLConnectionWrapper,
    _ensure_column_mysql,
    _ensure_index_mysql,
    _init_mysql_schema,
)

# Standardwerte aus .env.example als Fallback
ENV_EXAMPLE_DEFAULTS = {
    "host": "127.0.0.1",
    "port": 3306,
    "user": "toktracker_user",
    "password": "user_change_me_in_production",
    "database": "toktracker",
}

if PYMYSQL_AVAILABLE:
    import pymysql


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Migriert SQLite (tiktok_earnings.db) nach MariaDB / MySQL."
    )
    parser.add_argument(
        "--sqlite-path",
        default=config.db_path,
        help="Pfad zur SQLite-Datei (Standard: config.db_path)",
    )
    parser.add_argument(
        "--host",
        default=os.getenv("MYSQL_HOST") or ENV_EXAMPLE_DEFAULTS["host"],
        help="MariaDB / MySQL Host (Standard: MYSQL_HOST oder 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("MYSQL_PORT") or ENV_EXAMPLE_DEFAULTS["port"]),
        help="MariaDB / MySQL Port (Standard: 3306)",
    )
    env_user = os.getenv("MYSQL_USER", "").strip()
    env_pass = os.getenv("MYSQL_PASSWORD", "").strip()
    # Falls in .env noch keine echten Passwörter stehen, die Zugangsdaten aus .env.example nutzen:
    if not env_pass or env_pass == "your_mysql_password":
        fallback_user = ENV_EXAMPLE_DEFAULTS["user"]
        fallback_pass = ENV_EXAMPLE_DEFAULTS["password"]
    else:
        fallback_user = env_user or ENV_EXAMPLE_DEFAULTS["user"]
        fallback_pass = env_pass

    parser.add_argument(
        "--user",
        default=fallback_user,
        help="MariaDB / MySQL Benutzer (Standard: toktracker_user)",
    )
    parser.add_argument(
        "--password",
        default=fallback_pass,
        help="MariaDB / MySQL Passwort (Standard: user_change_me_in_production)",
    )
    parser.add_argument(
        "--database",
        default=os.getenv("MYSQL_DATABASE") or ENV_EXAMPLE_DEFAULTS["database"],
        help="MariaDB / MySQL Datenbankname (Standard: toktracker)",
    )
    return parser.parse_args()


def get_mysql_connection(host: str, port: int, user: str, password: str, database: str, create_db: bool = True):
    if not PYMYSQL_AVAILABLE:
        raise RuntimeError(
            "Das Python-Paket 'pymysql' ist nicht installiert. Bitte mit 'pip install pymysql' installieren."
        )

    if create_db:
        # Falls DB noch nicht existiert, Verbindung ohne DB aufbauen und CREATE DATABASE IF NOT EXISTS ausführen
        try:
            bootstrap = pymysql.connect(
                host=host,
                port=port,
                user=user,
                password=password,
                charset="utf8mb4",
                autocommit=True,
                connect_timeout=10,
            )
            with bootstrap.cursor() as cur:
                clean_db = re.sub(r"[^a-zA-Z0-9_]", "", database) or "toktracker"
                cur.execute(f"CREATE DATABASE IF NOT EXISTS `{clean_db}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
            bootstrap.close()
        except Exception as exc:
            print(f"[HINWEIS] Bootstrap CREATE DATABASE übersprungen: {exc}")

    conn = pymysql.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        database=database,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
        connect_timeout=10,
    )
    with conn.cursor() as cur:
        cur.execute("SET SESSION sql_mode = (SELECT REPLACE(@@sql_mode, 'ONLY_FULL_GROUP_BY', ''))")
    return conn


def migrate(
    sqlite_path: Optional[str] = None,
    host: Optional[str] = None,
    port: Optional[int] = None,
    user: Optional[str] = None,
    password: Optional[str] = None,
    database: Optional[str] = None,
) -> None:
    args = parse_args()

    target_sqlite = sqlite_path or args.sqlite_path
    target_host = host or args.host
    target_port = port or args.port
    target_user = user or args.user
    target_password = password or args.password
    target_database = database or args.database

    if not os.path.exists(target_sqlite):
        print(f"[ABBRUCH] Lokale SQLite-Datei nicht gefunden: {target_sqlite}")
        return

    print("=" * 70)
    print(" TOKTRACKER - DATENBANK-MIGRATION (SQLite -> MariaDB / MySQL)")
    print("=" * 70)
    print(f" Quell-SQLite:  {target_sqlite}")
    print(f" Ziel-MariaDB:  {target_user}@{target_host}:{target_port}/{target_database}")
    print("=" * 70)

    # 1. Ziel-Verbindung testen & Schema initialisieren
    # Aktualisiere temporär config-Werte für _init_mysql_schema
    config.mysql_host = target_host
    config.mysql_port = target_port
    config.mysql_user = target_user
    config.mysql_password = target_password
    config.mysql_database = target_database

    print("\n[1/7] Initialisiere Ziel-Schema in MariaDB...")
    try:
        _init_mysql_schema()
        print("      Schema & Indizes erfolgreich geprüft/erstellt.")
    except Exception as exc:
        print(f"[FEHLER] Verbindung oder Schema-Initialisierung fehlgeschlagen: {exc}")
        print("\nTipp:")
        print("- Läuft der MariaDB Docker-Container? ('docker compose ps')")
        print("- Stimmen Host, Port und Passwörter überein?")
        return

    src = sqlite3.connect(target_sqlite)
    src.row_factory = sqlite3.Row
    raw_dst = get_mysql_connection(target_host, target_port, target_user, target_password, target_database, create_db=False)
    dst = MySQLConnectionWrapper(raw_dst)

    try:
        # Fremdschlüssel-Prüfungen während des Massenimports temporär deaktivieren
        with raw_dst.cursor() as cur:
            cur.execute("SET FOREIGN_KEY_CHECKS = 0;")

        # ----------------------------------------------------------------------
        # 1. Settings
        # ----------------------------------------------------------------------
        settings_rows = src.execute("SELECT `key`, `value` FROM settings").fetchall()
        for r in settings_rows:
            dst.execute(
                "REPLACE INTO settings (`key`, `value`) VALUES (?, ?)",
                (r["key"], r["value"]),
            )
        print(f"[2/7] Settings übertragen: {len(settings_rows)}")

        # ----------------------------------------------------------------------
        # 2. Streamers
        # ----------------------------------------------------------------------
        streamer_rows = src.execute("SELECT * FROM streamers ORDER BY id ASC").fetchall()
        for r in streamer_rows:
            d = dict(r)
            dst.execute(
                """
                REPLACE INTO streamers (
                    id, username, display_name, avatar_url, room_id,
                    follower_count, is_live, is_tracking, auto_monitor,
                    current_viewers, last_error, created_at, last_seen_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    d["id"],
                    d["username"],
                    d.get("display_name") or d["username"],
                    d.get("avatar_url") or "",
                    d.get("room_id") or "",
                    int(d.get("follower_count") or 0),
                    int(d.get("is_live") or 0),
                    int(d.get("is_tracking") or 0),
                    int(d.get("auto_monitor") or 0),
                    int(d.get("current_viewers") or 0),
                    d.get("last_error") or "",
                    d["created_at"],
                    d.get("last_seen_at") or d["created_at"],
                ),
            )
        print(f"[3/7] Streamer übertragen: {len(streamer_rows)}")

        # ----------------------------------------------------------------------
        # 3. Stream Sessions
        # ----------------------------------------------------------------------
        session_rows = src.execute("SELECT * FROM stream_sessions ORDER BY id ASC").fetchall()
        for r in session_rows:
            d = dict(r)
            dst.execute(
                """
                REPLACE INTO stream_sessions (
                    id, streamer_id, room_id, title, started_at,
                    ended_at, peak_viewers, last_fan_tickets, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    d["id"],
                    d["streamer_id"],
                    d.get("room_id") or "",
                    d.get("title") or "",
                    d["started_at"],
                    d.get("ended_at"),
                    int(d.get("peak_viewers") or 0),
                    int(d.get("last_fan_tickets") or 0),
                    d.get("status") or "ended",
                ),
            )
        print(f"[4/7] Stream-Sessions übertragen: {len(session_rows)}")

        # ----------------------------------------------------------------------
        # 4. Gift Events
        # ----------------------------------------------------------------------
        gift_rows = src.execute("SELECT * FROM gift_events ORDER BY id ASC").fetchall()
        for r in gift_rows:
            d = dict(r)
            dst.execute(
                """
                INSERT IGNORE INTO gift_events (
                    id, streamer_id, session_id, event_uid,
                    sender_user_id, sender_username, sender_nickname, is_super_fan,
                    gift_id, gift_name, gift_icon_url,
                    diamond_count, repeat_count, combo_count, group_id, room_fan_tickets,
                    total_coins, usd_net, eur_net, usd_gross, eur_gross,
                    source, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    d["id"],
                    d["streamer_id"],
                    d.get("session_id"),
                    d.get("event_uid"),
                    d.get("sender_user_id") or "",
                    d["sender_username"],
                    d.get("sender_nickname") or d["sender_username"],
                    int(d.get("is_super_fan") or 0),
                    int(d.get("gift_id") or 0),
                    d["gift_name"],
                    d.get("gift_icon_url") or "",
                    int(d["diamond_count"]),
                    int(d["repeat_count"]),
                    int(d.get("combo_count") or 1),
                    d.get("group_id") or "",
                    int(d.get("room_fan_tickets") or 0),
                    int(d["total_coins"]),
                    float(d["usd_net"]),
                    float(d["eur_net"]),
                    float(d["usd_gross"]),
                    float(d["eur_gross"]),
                    d.get("source") or "tiktoklive",
                    d["created_at"],
                ),
            )
        print(f"[5/7] Gift-Events übertragen: {len(gift_rows)}")

        # ----------------------------------------------------------------------
        # 5. Telegram Users
        # ----------------------------------------------------------------------
        tg_rows = src.execute("SELECT * FROM telegram_users ORDER BY id ASC").fetchall()
        for r in tg_rows:
            d = dict(r)
            dst.execute(
                """
                REPLACE INTO telegram_users (
                    id, telegram_id, username, first_name,
                    role, is_allowed, note, created_at, last_seen_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    d["id"],
                    d.get("telegram_id"),
                    d.get("username") or "",
                    d.get("first_name") or "",
                    d.get("role") or "user",
                    int(d.get("is_allowed") or 0),
                    d.get("note") or "",
                    d["created_at"],
                    d.get("last_seen_at") or d["created_at"],
                ),
            )
        print(f"[6/7] Telegram-Nutzer übertragen: {len(tg_rows)}")

        # ----------------------------------------------------------------------
        # 6. TikTok Battles (1v1 und 2v2 PK-Duelle)
        # ----------------------------------------------------------------------
        has_battles_table = src.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tiktok_battles'"
        ).fetchone()[0] > 0

        battle_count = 0
        if has_battles_table:
            battle_rows = src.execute("SELECT * FROM tiktok_battles ORDER BY id ASC").fetchall()
            for r in battle_rows:
                d = dict(r)
                dst.execute(
                    """
                    REPLACE INTO tiktok_battles (
                        id, streamer_id, session_id, battle_id,
                        opponent_user_id, opponent_username, opponent_display_name, opponent_avatar_url,
                        started_at, ended_at, duration_seconds,
                        streamer_score, opponent_score, result,
                        streamer_mvp_name, streamer_mvp_score, streamer_mvp_avatar,
                        opponent_mvp_name, opponent_mvp_score, opponent_mvp_avatar,
                        coins_earned, usd_net, eur_net, usd_gross, eur_gross,
                        status, raw_data_json, created_at,
                        battle_mode,
                        teammate_user_id, teammate_username, teammate_display_name, teammate_avatar_url, teammate_score,
                        opponent2_user_id, opponent2_username, opponent2_display_name, opponent2_avatar_url, opponent2_score,
                        opponent3_user_id, opponent3_username, opponent3_display_name, opponent3_avatar_url, opponent3_score,
                        streamer_rank
                    ) VALUES (
                        ?, ?, ?, ?,
                        ?, ?, ?, ?,
                        ?, ?, ?,
                        ?, ?, ?,
                        ?, ?, ?,
                        ?, ?, ?,
                        ?, ?, ?, ?, ?,
                        ?, ?, ?,
                        ?,
                        ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?,
                        ?
                    )
                    """,
                    (
                        d["id"],
                        d["streamer_id"],
                        d.get("session_id"),
                        d.get("battle_id") or "",
                        d.get("opponent_user_id") or "",
                        d.get("opponent_username") or "",
                        d.get("opponent_display_name") or "",
                        d.get("opponent_avatar_url") or "",
                        d["started_at"],
                        d.get("ended_at"),
                        int(d.get("duration_seconds") or 300),
                        int(d.get("streamer_score") or 0),
                        int(d.get("opponent_score") or 0),
                        d.get("result") or "ONGOING",
                        d.get("streamer_mvp_name") or "",
                        int(d.get("streamer_mvp_score") or 0),
                        d.get("streamer_mvp_avatar") or "",
                        d.get("opponent_mvp_name") or "",
                        int(d.get("opponent_mvp_score") or 0),
                        d.get("opponent_mvp_avatar") or "",
                        int(d.get("coins_earned") or 0),
                        float(d.get("usd_net") or 0.0),
                        float(d.get("eur_net") or 0.0),
                        float(d.get("usd_gross") or 0.0),
                        float(d.get("eur_gross") or 0.0),
                        d.get("status") or "active",
                        d.get("raw_data_json") or "",
                        d["created_at"],
                        d.get("battle_mode") or "1v1",
                        d.get("teammate_user_id") or "",
                        d.get("teammate_username") or "",
                        d.get("teammate_display_name") or "",
                        d.get("teammate_avatar_url") or "",
                        int(d.get("teammate_score") or 0),
                        d.get("opponent2_user_id") or "",
                        d.get("opponent2_username") or "",
                        d.get("opponent2_display_name") or "",
                        d.get("opponent2_avatar_url") or "",
                        int(d.get("opponent2_score") or 0),
                        d.get("opponent3_user_id") or "",
                        d.get("opponent3_username") or "",
                        d.get("opponent3_display_name") or "",
                        d.get("opponent3_avatar_url") or "",
                        int(d.get("opponent3_score") or 0),
                        int(d.get("streamer_rank") or 0),
                    ),
                )
                battle_count += 1
        print(f"[7/8] TikTok Battles übertragen: {battle_count}")

        # ----------------------------------------------------------------------
        # 7. Chat-Nachrichten
        # ----------------------------------------------------------------------
        has_chat_table = src.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='chat_messages'"
        ).fetchone()[0] > 0
        chat_count = 0
        if has_chat_table:
            chat_rows = src.execute("SELECT * FROM chat_messages ORDER BY id ASC").fetchall()
            for r in chat_rows:
                d = dict(r)
                dst.execute(
                    """
                    INSERT IGNORE INTO chat_messages (
                        id, streamer_id, session_id, user_id,
                        username, nickname, avatar_url, comment,
                        is_whale, whale_tier, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        d["id"],
                        d["streamer_id"],
                        d.get("session_id"),
                        d.get("user_id") or "",
                        d["username"],
                        d.get("nickname") or d["username"],
                        d.get("avatar_url") or "",
                        d["comment"],
                        int(d.get("is_whale") or 0),
                        d.get("whale_tier") or "",
                        d["created_at"],
                    ),
                )
                chat_count += 1
        print(f"[8/9] Chat-Nachrichten übertragen: {chat_count}")

        # ----------------------------------------------------------------------
        # 8. Donor CRM (VIP Watchlist, Tags, Notes)
        # ----------------------------------------------------------------------
        has_crm_table = src.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='donor_crm'"
        ).fetchone()[0] > 0
        crm_count = 0
        if has_crm_table:
            crm_rows = src.execute("SELECT * FROM donor_crm ORDER BY id ASC").fetchall()
            for r in crm_rows:
                d = dict(r)
                dst.execute(
                    """
                    INSERT IGNORE INTO donor_crm (
                        id, username, is_vip, tags, notes, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        d["id"],
                        d["username"],
                        int(d.get("is_vip") or 0),
                        d.get("tags") or "",
                        d.get("notes") or "",
                        d["created_at"],
                        d["updated_at"],
                    ),
                )
                crm_count += 1
        print(f"[9/9] Spender-CRM (VIP/Notizen) übertragen: {crm_count}")

        # Fremdschlüssel-Prüfungen wieder aktivieren & Commit
        with raw_dst.cursor() as cur:
            cur.execute("SET FOREIGN_KEY_CHECKS = 1;")
        dst.commit()

        print("\n" + "=" * 70)
        print(" [ERFOLG] Die Migration wurde vollständig und fehlerfrei abgeschlossen!")
        print(f" - Settings:         {len(settings_rows)}")
        print(f" - Streamer:         {len(streamer_rows)}")
        print(f" - Sessions:         {len(session_rows)}")
        print(f" - Gift-Events:      {len(gift_rows)}")
        print(f" - Telegram-Users:   {len(tg_rows)}")
        print(f" - TikTok-Battles:   {battle_count}")
        print(f" - Chat-Nachrichten: {chat_count}")
        print(f" - Spender-CRM:      {crm_count}")
        print("=" * 70)

    except Exception as exc:
        dst.rollback()
        raise exc
    finally:
        src.close()
        raw_dst.close()


if __name__ == "__main__":
    migrate()
