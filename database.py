import copy
import os
import queue
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Generator, List, Optional, Sequence, Tuple, Union

try:
    import pymysql
    import pymysql.cursors
    PYMYSQL_AVAILABLE = True
except ImportError:
    pymysql = None  # type: ignore
    PYMYSQL_AVAILABLE = False

from config import config

DB_PATH = config.db_path

# Standard TikTok Umrechnungswerte:
# 1 Coin = 1 Diamond (im TikTokLive GiftEvent entspricht gift.diamond_count dem Coin-Wert)
# Creator erhält ca. 50% -> 1 Diamond = $0.005 USD Netto-Auszahlung ($5.00 pro 1.000 Coins/Diamonds)
DEFAULT_SETTINGS: Dict[str, str] = {
    "usd_per_diamond": "0.005",        # Netto-Auszahlung an Streamer pro Coin/Diamond in USD
    "gross_usd_per_coin": "0.0106",    # Brutto-Kaufpreis für Zuschauer pro Coin in USD
    "usd_to_eur_rate": "0.92",         # Wechselkurs USD -> EUR
    "currency_primary": "EUR",         # Primäre Anzeige-Währung (EUR oder USD)
    "poll_interval_seconds": "45",     # Intervall für Auto-Live-Check wenn Streamer offline ist
    "api_key": "",                     # Optionaler API-Key für externe Bot-Abfragen
    "telegram_access_mode": config.telegram_access_mode if config.telegram_access_mode in ("whitelist", "public") else "whitelist",
}

_db_init_lock = threading.Lock()
_db_initialized: bool = False


class DBRow(dict):
    """
    Kompatibilitäts-Zeilenobjekt für MySQL/MariaDB, das sich exakt wie `sqlite3.Row` verhält:
    - Unterstützt Dictionary-Zugriff (`row["username"]`, `dict(row)`, `row.get(...)`)
    - Unterstützt numerischen Index-Zugriff (`row[0]` z.B. bei `SELECT COUNT(*) ... fetchone()[0]`)
    """

    def __init__(self, data: Dict[str, Any]) -> None:
        super().__init__(data)
        self._values = list(data.values())

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, int):
            return self._values[key]
        return super().__getitem__(key)


class MySQLCursorWrapper:
    """Wrapper um den PyMySQL DictCursor mit `sqlite3.Cursor`-kompatibler Schnittstelle."""

    def __init__(self, raw_cursor: Any) -> None:
        self._cur = raw_cursor

    @property
    def lastrowid(self) -> int:
        return int(self._cur.lastrowid or 0)

    @property
    def rowcount(self) -> int:
        return int(self._cur.rowcount or 0)

    def fetchone(self) -> Optional[DBRow]:
        row = self._cur.fetchone()
        return DBRow(row) if row is not None else None

    def fetchall(self) -> List[DBRow]:
        rows = self._cur.fetchall()
        return [DBRow(r) for r in rows] if rows else []


class MySQLConnectionWrapper:
    """
    Übersetzt die SQLite-Queries aus `database.py` automatisch für MySQL / MariaDB:
    - `?` -> `%s`
    - `INSERT OR IGNORE INTO` -> `INSERT IGNORE INTO`
    - `INSERT OR REPLACE INTO` -> `REPLACE INTO`
    - `MAX(a, b)` (2 Argumente) -> `GREATEST(a, b)`
    """

    def __init__(self, raw_conn: Any) -> None:
        self._conn = raw_conn

    @staticmethod
    def _translate_sql(sql: str) -> str:
        out = sql.replace("?", "%s")
        out = re.sub(r"\bINSERT\s+OR\s+IGNORE\s+INTO\b", "INSERT IGNORE INTO", out, flags=re.IGNORECASE)
        out = re.sub(r"\bINSERT\s+OR\s+REPLACE\s+INTO\b", "REPLACE INTO", out, flags=re.IGNORECASE)
        out = re.sub(r"\bMAX\s*\(\s*last_fan_tickets\s*,\s*%s\s*\)", "GREATEST(last_fan_tickets, %s)", out, flags=re.IGNORECASE)
        return out

    def execute(self, sql: str, params: Optional[Sequence[Any]] = None) -> MySQLCursorWrapper:
        translated = self._translate_sql(sql)
        cur = self._conn.cursor()
        cur.execute(translated, tuple(params) if params is not None else None)
        return MySQLCursorWrapper(cur)

    def executemany(self, sql: str, seq_of_params: Sequence[Sequence[Any]]) -> MySQLCursorWrapper:
        translated = self._translate_sql(sql)
        cur = self._conn.cursor()
        cur.executemany(translated, [tuple(p) for p in seq_of_params])
        return MySQLCursorWrapper(cur)


    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()

    def close(self) -> None:
        # Verbindung wird vom MySQLConnectionPool verwaltet
        pass


class MySQLConnectionPool:
    """
    Thread-sicherer Connection-Pool für MySQL/MariaDB.
    Verhindert das ständige Neuaufbauen von TCP-Verbindungen (bis zu 8 Verb./Sekunde)
    und senkt CPU-Last von MariaDB und Python drastisch.
    """

    def __init__(self, max_size: int = 25, timeout: float = 15.0):
        self._pool: queue.Queue[Any] = queue.Queue(maxsize=max_size)
        self._max_size = max_size
        self._timeout = timeout
        self._created = 0
        self._lock = threading.Lock()

    def get_connection(self) -> Any:
        while True:
            try:
                conn = self._pool.get_nowait()
                try:
                    conn.ping(reconnect=True)
                    return conn
                except Exception:
                    try:
                        conn.close()
                    except Exception:
                        pass
                    with self._lock:
                        self._created = max(0, self._created - 1)
            except queue.Empty:
                break

        with self._lock:
            if self._created < self._max_size:
                self._created += 1
                can_create = True
            else:
                can_create = False

        if can_create:
            try:
                return _open_mysql_connection(include_db=True)
            except Exception:
                with self._lock:
                    self._created = max(0, self._created - 1)
                raise

        conn = self._pool.get(timeout=self._timeout)
        try:
            conn.ping(reconnect=True)
            return conn
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            with self._lock:
                self._created = max(0, self._created - 1)
            return _open_mysql_connection(include_db=True)

    def release_connection(self, conn: Any) -> None:
        if conn is None:
            return
        try:
            conn.rollback()
        except Exception:
            pass
        try:
            self._pool.put_nowait(conn)
        except queue.Full:
            try:
                conn.close()
            except Exception:
                pass
            with self._lock:
                self._created = max(0, self._created - 1)


_mysql_pool: Optional[MySQLConnectionPool] = None
_mysql_pool_lock = threading.Lock()


def get_mysql_pool() -> MySQLConnectionPool:
    global _mysql_pool
    if _mysql_pool is None:
        with _mysql_pool_lock:
            if _mysql_pool is None:
                _mysql_pool = MySQLConnectionPool(max_size=25, timeout=15.0)
    return _mysql_pool


def _open_mysql_connection(include_db: bool = True) -> Any:
    if not PYMYSQL_AVAILABLE:
        raise RuntimeError(
            "Für DB_ENGINE=mysql wird das Paket 'pymysql' benötigt (pip install pymysql)."
        )
    conn = pymysql.connect(
        host=config.mysql_host,
        port=config.mysql_port,
        user=config.mysql_user,
        password=config.mysql_password,
        database=config.mysql_database if include_db else None,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
        connect_timeout=10,
    )
    with conn.cursor() as cur:
        cur.execute("SET SESSION sql_mode = (SELECT REPLACE(@@sql_mode, 'ONLY_FULL_GROUP_BY', ''))")
    return conn


@contextmanager
def get_db() -> Generator[Any, None, None]:
    """
    Universeller Datenbank-Context-Manager für `toktracker`:
    - Standard (`DB_ENGINE=sqlite`): Lokale SQLite-Datenbank im schnellen WAL-Modus.
    - Externer SQL-Server (`DB_ENGINE=mysql`): MySQL / MariaDB über Thread-sicheren Connection-Pool.
    """
    if config.is_mysql:
        pool = get_mysql_pool()
        raw_conn = pool.get_connection()
        wrapper = MySQLConnectionWrapper(raw_conn)
        try:
            yield wrapper
            wrapper.commit()
        except Exception:
            wrapper.rollback()
            raise
        finally:
            pool.release_connection(raw_conn)
    else:
        conn = sqlite3.connect(DB_PATH, timeout=15.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def _ensure_column_sqlite(conn: sqlite3.Connection, table: str, column: str, col_def: str) -> None:
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_def}")


def _ensure_column_mysql(conn: MySQLConnectionWrapper, table: str, column: str, col_def: str) -> None:
    row = conn.execute(
        """
        SELECT COUNT(*) AS cnt
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
        """,
        (config.mysql_database, table, column),
    ).fetchone()
    if not row or int(row[0]) == 0:
        conn.execute(f"ALTER TABLE `{table}` ADD COLUMN `{column}` {col_def}")


def _ensure_index_mysql(conn: MySQLConnectionWrapper, table: str, index_name: str, columns_sql: str, unique: bool = False) -> None:
    row = conn.execute(
        """
        SELECT COUNT(*) AS cnt
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?
        """,
        (config.mysql_database, table, index_name),
    ).fetchone()
    if not row or int(row[0]) == 0:
        uniq_kw = "UNIQUE " if unique else ""
        conn.execute(f"CREATE {uniq_kw}INDEX {index_name} ON {table}({columns_sql})")


def _init_mysql_schema() -> None:
    # 1. Datenbank anlegen, falls sie noch nicht existiert
    try:
        bootstrap_conn = _open_mysql_connection(include_db=False)
        try:
            with bootstrap_conn.cursor() as cur:
                db_name = re.sub(r"[^a-zA-Z0-9_]", "", config.mysql_database) or "toktracker"
                cur.execute(
                    f"CREATE DATABASE IF NOT EXISTS `{db_name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                )
            bootstrap_conn.commit()
        finally:
            bootstrap_conn.close()
    except Exception:
        # Falls der MySQL-User keine CREATE DATABASE Rechte hat und die DB bereits existiert, normal fortfahren
        pass

    raw_conn = _open_mysql_connection(include_db=True)
    conn = MySQLConnectionWrapper(raw_conn)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                `key` VARCHAR(128) PRIMARY KEY,
                `value` TEXT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS streamers (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(191) NOT NULL UNIQUE,
                display_name VARCHAR(255),
                avatar_url TEXT,
                room_id VARCHAR(128),
                follower_count BIGINT DEFAULT 0,
                is_live TINYINT DEFAULT 0,
                is_tracking TINYINT DEFAULT 0,
                auto_monitor TINYINT DEFAULT 0,
                current_viewers INT DEFAULT 0,
                last_error TEXT,
                created_at VARCHAR(64) NOT NULL,
                last_seen_at VARCHAR(64)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS stream_sessions (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                streamer_id BIGINT NOT NULL,
                room_id VARCHAR(128),
                title VARCHAR(512) DEFAULT '',
                started_at VARCHAR(64) NOT NULL,
                ended_at VARCHAR(64),
                peak_viewers INT DEFAULT 0,
                last_fan_tickets BIGINT DEFAULT 0,
                status VARCHAR(32) DEFAULT 'active',
                CONSTRAINT fk_sessions_streamer FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS gift_events (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                streamer_id BIGINT NOT NULL,
                session_id BIGINT NULL,
                event_uid VARCHAR(191) UNIQUE,
                sender_user_id VARCHAR(128) DEFAULT '',
                sender_username VARCHAR(191) NOT NULL,
                sender_nickname VARCHAR(255),
                is_super_fan TINYINT DEFAULT 0,
                gift_id INT DEFAULT 0,
                gift_name VARCHAR(255) NOT NULL,
                gift_icon_url TEXT,
                diamond_count INT NOT NULL,
                repeat_count INT NOT NULL DEFAULT 1,
                combo_count INT DEFAULT 1,
                group_id VARCHAR(128) DEFAULT '',
                room_fan_tickets BIGINT DEFAULT 0,
                total_coins BIGINT NOT NULL,
                usd_net DOUBLE NOT NULL,
                eur_net DOUBLE NOT NULL,
                usd_gross DOUBLE NOT NULL,
                eur_gross DOUBLE NOT NULL,
                source VARCHAR(64) DEFAULT 'tiktoklive',
                created_at VARCHAR(64) NOT NULL,
                CONSTRAINT fk_gifts_streamer FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE,
                CONSTRAINT fk_gifts_session FOREIGN KEY (session_id) REFERENCES stream_sessions(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS telegram_users (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                telegram_id BIGINT UNIQUE,
                username VARCHAR(191),
                first_name VARCHAR(255) DEFAULT '',
                role VARCHAR(32) DEFAULT 'user',
                is_allowed TINYINT DEFAULT 0,
                note VARCHAR(512) DEFAULT '',
                created_at VARCHAR(64) NOT NULL,
                last_seen_at VARCHAR(64)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tiktok_battles (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                streamer_id BIGINT NOT NULL,
                session_id BIGINT NULL,
                battle_id VARCHAR(128) NOT NULL,
                opponent_user_id VARCHAR(128) DEFAULT '',
                opponent_username VARCHAR(191) DEFAULT '',
                opponent_display_name VARCHAR(255) DEFAULT '',
                opponent_avatar_url TEXT,
                started_at VARCHAR(64) NOT NULL,
                ended_at VARCHAR(64),
                duration_seconds INT DEFAULT 300,
                streamer_score INT DEFAULT 0,
                opponent_score INT DEFAULT 0,
                result VARCHAR(32) DEFAULT 'ONGOING',
                streamer_mvp_name VARCHAR(255) DEFAULT '',
                streamer_mvp_score INT DEFAULT 0,
                streamer_mvp_avatar TEXT,
                opponent_mvp_name VARCHAR(255) DEFAULT '',
                opponent_mvp_score INT DEFAULT 0,
                opponent_mvp_avatar TEXT,
                coins_earned BIGINT DEFAULT 0,
                usd_net DOUBLE DEFAULT 0.0,
                eur_net DOUBLE DEFAULT 0.0,
                usd_gross DOUBLE DEFAULT 0.0,
                eur_gross DOUBLE DEFAULT 0.0,
                status VARCHAR(32) DEFAULT 'active',
                raw_data_json MEDIUMTEXT,
                created_at VARCHAR(64) NOT NULL,
                CONSTRAINT fk_battles_streamer FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE,
                CONSTRAINT fk_battles_session FOREIGN KEY (session_id) REFERENCES stream_sessions(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS page_views (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                path VARCHAR(255) NOT NULL,
                visitor_hash VARCHAR(64) NOT NULL,
                user_agent VARCHAR(512) DEFAULT '',
                device_type VARCHAR(32) DEFAULT 'desktop',
                referrer VARCHAR(512) DEFAULT '',
                status_code INT DEFAULT 200,
                response_time_ms DOUBLE DEFAULT 0.0,
                created_at VARCHAR(64) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS bot_sessions (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                session_type VARCHAR(32) NOT NULL,
                telegram_id BIGINT NULL,
                username VARCHAR(191) DEFAULT '',
                first_name VARCHAR(255) DEFAULT '',
                client_ip_hash VARCHAR(64) DEFAULT '',
                status VARCHAR(32) DEFAULT 'active',
                details_json TEXT,
                created_at VARCHAR(64) NOT NULL,
                last_active_at VARCHAR(64) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_messages (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                streamer_id BIGINT NOT NULL,
                session_id BIGINT NULL,
                user_id VARCHAR(128) DEFAULT '',
                username VARCHAR(191) NOT NULL,
                nickname VARCHAR(255) DEFAULT '',
                avatar_url TEXT,
                comment TEXT NOT NULL,
                is_whale TINYINT DEFAULT 0,
                whale_tier VARCHAR(32) DEFAULT '',
                created_at VARCHAR(64) NOT NULL,
                CONSTRAINT fk_chat_streamer FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE,
                CONSTRAINT fk_chat_session FOREIGN KEY (session_id) REFERENCES stream_sessions(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS donor_crm (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(191) NOT NULL UNIQUE,
                is_vip TINYINT DEFAULT 0,
                tags TEXT,
                notes TEXT,
                created_at VARCHAR(64) NOT NULL,
                updated_at VARCHAR(64) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """
        )

        _ensure_index_mysql(conn, "gift_events", "idx_gift_events_streamer_date", "streamer_id, created_at")
        _ensure_index_mysql(conn, "gift_events", "idx_gift_events_session", "session_id")
        _ensure_index_mysql(conn, "gift_events", "idx_gift_events_sender", "sender_username")
        _ensure_index_mysql(conn, "stream_sessions", "idx_stream_sessions_streamer", "streamer_id, started_at")
        _ensure_index_mysql(conn, "telegram_users", "idx_telegram_users_username", "username")
        _ensure_index_mysql(conn, "tiktok_battles", "idx_battles_streamer", "streamer_id, created_at")
        _ensure_index_mysql(conn, "tiktok_battles", "idx_battles_battle_id", "battle_id")
        _ensure_index_mysql(conn, "tiktok_battles", "idx_battles_result", "result")
        _ensure_index_mysql(conn, "tiktok_battles", "idx_battles_opponent", "opponent_username")
        _ensure_index_mysql(conn, "page_views", "idx_page_views_created", "created_at")
        _ensure_index_mysql(conn, "page_views", "idx_page_views_path", "path")
        _ensure_index_mysql(conn, "page_views", "idx_page_views_visitor", "visitor_hash, created_at")
        _ensure_index_mysql(conn, "bot_sessions", "idx_bot_sessions_type", "session_type, created_at")
        _ensure_index_mysql(conn, "bot_sessions", "idx_bot_sessions_telegram_id", "telegram_id")
        _ensure_index_mysql(conn, "chat_messages", "idx_chat_messages_streamer_created", "streamer_id, created_at")
        _ensure_index_mysql(conn, "chat_messages", "idx_chat_messages_created", "created_at")
        _ensure_index_mysql(conn, "chat_messages", "idx_chat_messages_username", "username")
        _ensure_index_mysql(conn, "chat_messages", "idx_chat_messages_whale", "is_whale, streamer_id")
        _ensure_index_mysql(conn, "donor_crm", "idx_donor_crm_username", "username")
        _ensure_index_mysql(conn, "donor_crm", "idx_donor_crm_vip", "is_vip")

        _ensure_column_mysql(conn, "tiktok_battles", "battle_mode", "VARCHAR(32) DEFAULT '1v1'")
        _ensure_column_mysql(conn, "tiktok_battles", "teammate_user_id", "VARCHAR(128) DEFAULT ''")
        _ensure_column_mysql(conn, "tiktok_battles", "teammate_username", "VARCHAR(191) DEFAULT ''")
        _ensure_column_mysql(conn, "tiktok_battles", "teammate_display_name", "VARCHAR(255) DEFAULT ''")
        _ensure_column_mysql(conn, "tiktok_battles", "teammate_avatar_url", "TEXT")
        _ensure_column_mysql(conn, "tiktok_battles", "teammate_score", "BIGINT DEFAULT 0")
        _ensure_column_mysql(conn, "tiktok_battles", "opponent2_user_id", "VARCHAR(128) DEFAULT ''")
        _ensure_column_mysql(conn, "tiktok_battles", "opponent2_username", "VARCHAR(191) DEFAULT ''")
        _ensure_column_mysql(conn, "tiktok_battles", "opponent2_display_name", "VARCHAR(255) DEFAULT ''")
        _ensure_column_mysql(conn, "tiktok_battles", "opponent2_avatar_url", "TEXT")
        _ensure_column_mysql(conn, "tiktok_battles", "opponent2_score", "BIGINT DEFAULT 0")
        _ensure_column_mysql(conn, "tiktok_battles", "opponent3_user_id", "VARCHAR(128) DEFAULT ''")
        _ensure_column_mysql(conn, "tiktok_battles", "opponent3_username", "VARCHAR(191) DEFAULT ''")
        _ensure_column_mysql(conn, "tiktok_battles", "opponent3_display_name", "VARCHAR(255) DEFAULT ''")
        _ensure_column_mysql(conn, "tiktok_battles", "opponent3_avatar_url", "TEXT")
        _ensure_column_mysql(conn, "tiktok_battles", "opponent3_score", "BIGINT DEFAULT 0")
        _ensure_column_mysql(conn, "tiktok_battles", "streamer_rank", "INT DEFAULT 0")
        conn.commit()
    finally:
        raw_conn.close()


def _init_sqlite_schema() -> None:
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                `key` TEXT PRIMARY KEY,
                `value` TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS streamers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                display_name TEXT,
                avatar_url TEXT,
                room_id TEXT,
                follower_count INTEGER DEFAULT 0,
                is_live INTEGER DEFAULT 0,
                is_tracking INTEGER DEFAULT 0,
                auto_monitor INTEGER DEFAULT 0,
                current_viewers INTEGER DEFAULT 0,
                last_error TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                last_seen_at TEXT
            );

            CREATE TABLE IF NOT EXISTS stream_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                streamer_id INTEGER NOT NULL,
                room_id TEXT,
                title TEXT DEFAULT '',
                started_at TEXT NOT NULL,
                ended_at TEXT,
                peak_viewers INTEGER DEFAULT 0,
                last_fan_tickets INTEGER DEFAULT 0,
                status TEXT DEFAULT 'active',
                FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS gift_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                streamer_id INTEGER NOT NULL,
                session_id INTEGER,
                event_uid TEXT UNIQUE,
                sender_user_id TEXT DEFAULT '',
                sender_username TEXT NOT NULL,
                sender_nickname TEXT,
                is_super_fan INTEGER DEFAULT 0,
                gift_id INTEGER DEFAULT 0,
                gift_name TEXT NOT NULL,
                gift_icon_url TEXT,
                diamond_count INTEGER NOT NULL,
                repeat_count INTEGER NOT NULL DEFAULT 1,
                combo_count INTEGER DEFAULT 1,
                group_id TEXT DEFAULT '',
                room_fan_tickets INTEGER DEFAULT 0,
                total_coins INTEGER NOT NULL,
                usd_net REAL NOT NULL,
                eur_net REAL NOT NULL,
                usd_gross REAL NOT NULL,
                eur_gross REAL NOT NULL,
                source TEXT DEFAULT 'tiktoklive',
                created_at TEXT NOT NULL,
                FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id) REFERENCES stream_sessions(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS telegram_users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_id INTEGER UNIQUE,
                username TEXT COLLATE NOCASE,
                first_name TEXT DEFAULT '',
                role TEXT DEFAULT 'user',
                is_allowed INTEGER DEFAULT 0,
                note TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                last_seen_at TEXT
            );

            CREATE TABLE IF NOT EXISTS tiktok_battles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                streamer_id INTEGER NOT NULL,
                session_id INTEGER,
                battle_id TEXT NOT NULL,
                opponent_user_id TEXT DEFAULT '',
                opponent_username TEXT DEFAULT '',
                opponent_display_name TEXT DEFAULT '',
                opponent_avatar_url TEXT,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                duration_seconds INTEGER DEFAULT 300,
                streamer_score INTEGER DEFAULT 0,
                opponent_score INTEGER DEFAULT 0,
                result TEXT DEFAULT 'ONGOING',
                streamer_mvp_name TEXT DEFAULT '',
                streamer_mvp_score INTEGER DEFAULT 0,
                streamer_mvp_avatar TEXT,
                opponent_mvp_name TEXT DEFAULT '',
                opponent_mvp_score INTEGER DEFAULT 0,
                opponent_mvp_avatar TEXT,
                coins_earned INTEGER DEFAULT 0,
                usd_net REAL DEFAULT 0.0,
                eur_net REAL DEFAULT 0.0,
                usd_gross REAL DEFAULT 0.0,
                eur_gross REAL DEFAULT 0.0,
                status TEXT DEFAULT 'active',
                raw_data_json TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id) REFERENCES stream_sessions(id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS page_views (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL,
                visitor_hash TEXT NOT NULL,
                user_agent TEXT DEFAULT '',
                device_type TEXT DEFAULT 'desktop',
                referrer TEXT DEFAULT '',
                status_code INTEGER DEFAULT 200,
                response_time_ms REAL DEFAULT 0.0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bot_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_type TEXT NOT NULL,
                telegram_id INTEGER NULL,
                username TEXT DEFAULT '',
                first_name TEXT DEFAULT '',
                client_ip_hash TEXT DEFAULT '',
                status TEXT DEFAULT 'active',
                details_json TEXT,
                created_at TEXT NOT NULL,
                last_active_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                streamer_id INTEGER NOT NULL,
                session_id INTEGER,
                user_id TEXT DEFAULT '',
                username TEXT NOT NULL COLLATE NOCASE,
                nickname TEXT DEFAULT '',
                avatar_url TEXT,
                comment TEXT NOT NULL,
                is_whale INTEGER DEFAULT 0,
                whale_tier TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY (streamer_id) REFERENCES streamers(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id) REFERENCES stream_sessions(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS donor_crm (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                is_vip INTEGER DEFAULT 0,
                tags TEXT DEFAULT '',
                notes TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )

        _ensure_column_sqlite(conn, "streamers", "auto_monitor", "INTEGER DEFAULT 0")
        _ensure_column_sqlite(conn, "streamers", "current_viewers", "INTEGER DEFAULT 0")
        _ensure_column_sqlite(conn, "streamers", "last_error", "TEXT DEFAULT ''")

        _ensure_column_sqlite(conn, "gift_events", "session_id", "INTEGER")
        _ensure_column_sqlite(conn, "gift_events", "event_uid", "TEXT")
        _ensure_column_sqlite(conn, "gift_events", "sender_user_id", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "gift_events", "is_super_fan", "INTEGER DEFAULT 0")
        _ensure_column_sqlite(conn, "gift_events", "combo_count", "INTEGER DEFAULT 1")
        _ensure_column_sqlite(conn, "gift_events", "group_id", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "gift_events", "room_fan_tickets", "INTEGER DEFAULT 0")

        _ensure_column_sqlite(conn, "tiktok_battles", "battle_mode", "TEXT DEFAULT '1v1'")
        _ensure_column_sqlite(conn, "tiktok_battles", "teammate_user_id", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "tiktok_battles", "teammate_username", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "tiktok_battles", "teammate_display_name", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "tiktok_battles", "teammate_avatar_url", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "tiktok_battles", "teammate_score", "INTEGER DEFAULT 0")
        _ensure_column_sqlite(conn, "tiktok_battles", "opponent2_user_id", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "tiktok_battles", "opponent2_username", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "tiktok_battles", "opponent2_display_name", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "tiktok_battles", "opponent2_avatar_url", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "tiktok_battles", "opponent2_score", "INTEGER DEFAULT 0")
        _ensure_column_sqlite(conn, "tiktok_battles", "opponent3_user_id", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "tiktok_battles", "opponent3_username", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "tiktok_battles", "opponent3_display_name", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "tiktok_battles", "opponent3_avatar_url", "TEXT DEFAULT ''")
        _ensure_column_sqlite(conn, "tiktok_battles", "opponent3_score", "INTEGER DEFAULT 0")
        _ensure_column_sqlite(conn, "tiktok_battles", "streamer_rank", "INTEGER DEFAULT 0")

        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_gift_events_streamer_date
                ON gift_events(streamer_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_gift_events_session
                ON gift_events(session_id);
            CREATE INDEX IF NOT EXISTS idx_gift_events_sender
                ON gift_events(sender_username);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_events_uid
                ON gift_events(event_uid) WHERE event_uid IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_stream_sessions_streamer
                ON stream_sessions(streamer_id, started_at);
            CREATE INDEX IF NOT EXISTS idx_telegram_users_username
                ON telegram_users(username);
            CREATE INDEX IF NOT EXISTS idx_battles_streamer
                ON tiktok_battles(streamer_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_battles_battle_id
                ON tiktok_battles(battle_id);
            CREATE INDEX IF NOT EXISTS idx_battles_result
                ON tiktok_battles(result);
            CREATE INDEX IF NOT EXISTS idx_battles_opponent
                ON tiktok_battles(opponent_username);
            CREATE INDEX IF NOT EXISTS idx_page_views_created
                ON page_views(created_at);
            CREATE INDEX IF NOT EXISTS idx_page_views_path
                ON page_views(path);
            CREATE INDEX IF NOT EXISTS idx_page_views_visitor
                ON page_views(visitor_hash, created_at);
            CREATE INDEX IF NOT EXISTS idx_bot_sessions_type
                ON bot_sessions(session_type, created_at);
            CREATE INDEX IF NOT EXISTS idx_bot_sessions_telegram_id
                ON bot_sessions(telegram_id);
            CREATE INDEX IF NOT EXISTS idx_chat_messages_streamer_created
                ON chat_messages(streamer_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_chat_messages_created
                ON chat_messages(created_at);
            CREATE INDEX IF NOT EXISTS idx_chat_messages_username
                ON chat_messages(username);
            CREATE INDEX IF NOT EXISTS idx_chat_messages_whale
                ON chat_messages(is_whale, streamer_id);
            CREATE INDEX IF NOT EXISTS idx_donor_crm_username
                ON donor_crm(username);
            CREATE INDEX IF NOT EXISTS idx_donor_crm_vip
                ON donor_crm(is_vip);
            """
        )


def init_db(force: bool = False) -> None:
    global _db_initialized
    with _db_init_lock:
        if _db_initialized and not force:
            return
        if config.is_mysql:
            _init_mysql_schema()
        else:
            _init_sqlite_schema()

        with get_db() as conn:
            for k, v in DEFAULT_SETTINGS.items():
                conn.execute(
                    "INSERT OR IGNORE INTO settings (`key`, `value`) VALUES (?, ?)", (k, v)
                )

            # Initiale Admins/Whitelist-User aus der .env synchronisieren
            now = datetime.now().isoformat(timespec="seconds")
            for tg_id in config.env_allowed_telegram_ids:
                existing = conn.execute(
                    "SELECT id FROM telegram_users WHERE telegram_id = ?", (tg_id,)
                ).fetchone()
                if existing:
                    conn.execute(
                        "UPDATE telegram_users SET is_allowed = 1, role = 'admin' WHERE id = ?",
                        (existing["id"],),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO telegram_users (telegram_id, username, first_name, role, is_allowed, note, created_at, last_seen_at)
                        VALUES (?, '', 'ENV Admin', 'admin', 1, 'Aus .env geladen', ?, ?)
                        """,
                        (tg_id, now, now),
                    )

            for tg_uname in config.env_allowed_telegram_usernames:
                existing = conn.execute(
                    "SELECT id FROM telegram_users WHERE LOWER(username) = LOWER(?)",
                    (tg_uname,),
                ).fetchone()
                if existing:
                    conn.execute(
                        "UPDATE telegram_users SET is_allowed = 1, role = 'admin' WHERE id = ?",
                        (existing["id"],),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO telegram_users (telegram_id, username, first_name, role, is_allowed, note, created_at, last_seen_at)
                        VALUES (NULL, ?, 'ENV Admin', 'admin', 1, 'Aus .env geladen', ?, ?)
                        """,
                        (tg_uname.lower(), now, now),
                    )
        _db_initialized = True


_settings_cache: Optional[Dict[str, Any]] = None
_settings_cache_time: float = 0.0
_settings_cache_lock = threading.Lock()
_SETTINGS_TTL = 30.0  # Sekunden Cache gegen DB-Spamming


def invalidate_settings_cache() -> None:
    global _settings_cache_time
    _settings_cache_time = 0.0


def get_settings(force_refresh: bool = False) -> Dict[str, Any]:
    global _settings_cache, _settings_cache_time
    now = time.monotonic()
    if not force_refresh and _settings_cache is not None and (now - _settings_cache_time) < _SETTINGS_TTL:
        return _settings_cache.copy()

    with _settings_cache_lock:
        if not force_refresh and _settings_cache is not None and (now - _settings_cache_time) < _SETTINGS_TTL:
            return _settings_cache.copy()

        with get_db() as conn:
            rows = conn.execute("SELECT `key`, `value` FROM settings").fetchall()
            data = {r["key"]: r["value"] for r in rows}
        mode = str(data.get("telegram_access_mode", config.telegram_access_mode or "whitelist")).lower()
        if mode not in ("whitelist", "public"):
            mode = "whitelist"
        res = {
            "usd_per_diamond": float(data.get("usd_per_diamond", 0.005)),
            "gross_usd_per_coin": float(data.get("gross_usd_per_coin", 0.0106)),
            "usd_to_eur_rate": float(data.get("usd_to_eur_rate", 0.92)),
            "currency_primary": data.get("currency_primary", "EUR"),
            "poll_interval_seconds": int(float(data.get("poll_interval_seconds", 45))),
            "api_key": str(data.get("api_key", "")),
            "telegram_access_mode": mode,
        }
        _settings_cache = res
        _settings_cache_time = now
        return res.copy()


def update_settings(new_settings: Dict[str, Any]) -> Dict[str, Any]:
    with get_db() as conn:
        for key in DEFAULT_SETTINGS.keys():
            if key in new_settings and new_settings[key] is not None:
                val = str(new_settings[key]).strip()
                if key == "telegram_access_mode":
                    val = val.lower()
                    if val not in ("whitelist", "public"):
                        continue
                conn.execute(
                    "INSERT OR REPLACE INTO settings (`key`, `value`) VALUES (?, ?)",
                    (key, val),
                )
    invalidate_settings_cache()
    return get_settings(force_refresh=True)


# =====================================================================
# TELEGRAM ZUGRIFFSKONTROLLE (WHITELIST / PUBLIC / ROLLEN / GRUPPEN)
# =====================================================================

def get_telegram_access_mode() -> str:
    return get_settings().get("telegram_access_mode", "whitelist")


def set_telegram_access_mode(mode: str) -> str:
    clean_mode = mode.strip().lower()
    if clean_mode not in ("whitelist", "public"):
        raise ValueError("Modus muss 'whitelist' oder 'public' sein.")
    update_settings({"telegram_access_mode": clean_mode})
    return clean_mode


def list_telegram_users() -> List[Dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM telegram_users
            ORDER BY is_allowed DESC, CASE WHEN role = 'admin' THEN 0 ELSE 1 END ASC, id DESC
            """
        ).fetchall()
        return [dict(r) for r in rows]


def upsert_telegram_user_permission(
    identifier: str | int,
    is_allowed: int | bool = 1,
    role: str = "user",
    first_name: Optional[str] = None,
    note: Optional[str] = None,
    telegram_id_override: Optional[int] = None,
    username_override: Optional[str] = None,
) -> Dict[str, Any]:
    raw = str(identifier).strip()
    if not raw:
        raise ValueError("Bitte eine Telegram User-ID oder einen [@]username angeben.")

    clean_role = role.strip().lower() if role else "user"
    if clean_role not in ("admin", "user"):
        clean_role = "user"

    allowed_val = int(is_allowed)
    if allowed_val not in (-1, 0, 1):
        allowed_val = 1 if bool(is_allowed) else 0

    now = datetime.now().isoformat(timespec="seconds")
    clean_ident = raw.lstrip("@").strip()
    is_numeric_id = clean_ident.lstrip("-").isdigit()

    with get_db() as conn:
        existing = None
        tg_id: Optional[int] = telegram_id_override
        uname: Optional[str] = (username_override or "").strip().lstrip("@").lower() or None

        if is_numeric_id:
            tg_id = int(clean_ident)
            existing = conn.execute(
                "SELECT * FROM telegram_users WHERE telegram_id = ? OR id = ?",
                (tg_id, tg_id),
            ).fetchone()
            if not existing and uname:
                existing = conn.execute(
                    "SELECT * FROM telegram_users WHERE LOWER(username) = LOWER(?)",
                    (uname,),
                ).fetchone()
        else:
            uname = clean_ident.lower()
            existing = conn.execute(
                "SELECT * FROM telegram_users WHERE LOWER(username) = LOWER(?)",
                (uname,),
            ).fetchone()
            if not existing and tg_id is not None:
                existing = conn.execute(
                    "SELECT * FROM telegram_users WHERE telegram_id = ?",
                    (tg_id,),
                ).fetchone()

        if existing:
            new_tg_id = tg_id if tg_id is not None else existing["telegram_id"]
            new_uname = uname if uname else existing["username"]
            new_fname = first_name if first_name is not None else existing["first_name"]
            new_note = note if note is not None else existing["note"]
            conn.execute(
                """
                UPDATE telegram_users
                SET telegram_id = ?, username = ?, is_allowed = ?, role = ?, first_name = ?, note = ?, last_seen_at = ?
                WHERE id = ?
                """,
                (new_tg_id, new_uname, allowed_val, clean_role, new_fname, new_note, now, existing["id"]),
            )
            row_id = existing["id"]
        else:
            cur = conn.execute(
                """
                INSERT INTO telegram_users (
                    telegram_id, username, first_name, role, is_allowed, note, created_at, last_seen_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tg_id,
                    uname or "",
                    first_name or "",
                    clean_role,
                    allowed_val,
                    note or "Manuell angelegt",
                    now,
                    now,
                ),
            )
            row_id = cur.lastrowid

        row = conn.execute(
            "SELECT * FROM telegram_users WHERE id = ?", (row_id,)
        ).fetchone()
        return dict(row)


def delete_telegram_user(record_id: int) -> bool:
    with get_db() as conn:
        cur = conn.execute("DELETE FROM telegram_users WHERE id = ?", (record_id,))
        return cur.rowcount > 0


def check_telegram_user_access(
    telegram_id: int,
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    chat_id: Optional[int] = None,
    chat_title: Optional[str] = None,
) -> Dict[str, Any]:
    clean_uname = (username or "").strip().lstrip("@").lower()
    clean_fname = (first_name or "").strip()
    now = datetime.now().isoformat(timespec="seconds")
    mode = get_telegram_access_mode()

    in_env_admin = (
        telegram_id in config.env_allowed_telegram_ids
        or (clean_uname and clean_uname in config.env_allowed_telegram_usernames)
    )

    is_group = bool(chat_id is not None and chat_id != telegram_id)
    source_note = (
        f"Gruppe: {chat_title or chat_id}" if is_group else "Privatchat"
    )

    with get_db() as conn:
        row_by_id = conn.execute(
            "SELECT * FROM telegram_users WHERE telegram_id = ?", (telegram_id,)
        ).fetchone()

        row_by_uname = None
        if clean_uname:
            row_by_uname = conn.execute(
                "SELECT * FROM telegram_users WHERE LOWER(username) = LOWER(?)",
                (clean_uname,),
            ).fetchone()

        if row_by_id and row_by_uname and row_by_id["id"] != row_by_uname["id"]:
            merged_allowed = max(int(row_by_id["is_allowed"]), int(row_by_uname["is_allowed"]))
            if int(row_by_id["is_allowed"]) < 0 or int(row_by_uname["is_allowed"]) < 0:
                if max(int(row_by_id["is_allowed"]), int(row_by_uname["is_allowed"])) < 1:
                    merged_allowed = -1
            merged_role = (
                "admin"
                if (row_by_id["role"] == "admin" or row_by_uname["role"] == "admin")
                else "user"
            )
            conn.execute("DELETE FROM telegram_users WHERE id = ?", (row_by_uname["id"],))
            conn.execute(
                "UPDATE telegram_users SET is_allowed = ?, role = ? WHERE id = ?",
                (merged_allowed, merged_role, row_by_id["id"]),
            )
            row = conn.execute(
                "SELECT * FROM telegram_users WHERE id = ?", (row_by_id["id"],)
            ).fetchone()
        else:
            row = row_by_id or row_by_uname

        if row:
            new_role = "admin" if in_env_admin else row["role"]
            new_allowed = 1 if in_env_admin else int(row["is_allowed"])
            conn.execute(
                """
                UPDATE telegram_users
                SET telegram_id = ?,
                    username = COALESCE(NULLIF(?, ''), username),
                    first_name = COALESCE(NULLIF(?, ''), first_name),
                    role = ?,
                    is_allowed = ?,
                    last_seen_at = ?
                WHERE id = ?
                """,
                (
                    telegram_id,
                    clean_uname,
                    clean_fname,
                    new_role,
                    new_allowed,
                    now,
                    row["id"],
                ),
            )
            row_id = row["id"]
        else:
            initial_role = "admin" if in_env_admin else "user"
            initial_allowed = 1 if in_env_admin else 0
            note = "Aus .env autorisiert" if in_env_admin else f"Anfrage ({source_note})"
            cur = conn.execute(
                """
                INSERT INTO telegram_users (
                    telegram_id, username, first_name, role, is_allowed, note, created_at, last_seen_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    telegram_id,
                    clean_uname,
                    clean_fname,
                    initial_role,
                    initial_allowed,
                    note,
                    now,
                    now,
                ),
            )
            row_id = cur.lastrowid

        user_row = dict(
            conn.execute("SELECT * FROM telegram_users WHERE id = ?", (row_id,)).fetchone()
        )

        group_whitelisted = False
        if is_group and chat_id is not None:
            grp_row = conn.execute(
                "SELECT is_allowed FROM telegram_users WHERE telegram_id = ?",
                (int(chat_id),),
            ).fetchone()
            if grp_row and int(grp_row["is_allowed"]) == 1:
                group_whitelisted = True

    is_allowed_flag = int(user_row.get("is_allowed", 0))
    role_val = user_row.get("role", "user")

    if is_allowed_flag < 0:
        allowed = False
        is_admin = False
    elif mode == "public":
        allowed = True
        is_admin = bool(is_allowed_flag == 1 and role_val == "admin")
    else:
        allowed = bool(is_allowed_flag == 1 or group_whitelisted)
        is_admin = bool(is_allowed_flag == 1 and role_val == "admin")

    return {
        "allowed": allowed,
        "is_admin": is_admin,
        "mode": mode,
        "is_group": is_group,
        "user": user_row,
    }


def get_streamer_by_id_or_username(identifier: str | int) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        if isinstance(identifier, int) or str(identifier).isdigit():
            row = conn.execute(
                "SELECT * FROM streamers WHERE id = ?", (int(identifier),)
            ).fetchone()
            if row:
                return dict(row)
        clean = str(identifier).strip().lstrip("@").lower()
        row = conn.execute(
            "SELECT * FROM streamers WHERE LOWER(username) = LOWER(?)", (clean,)
        ).fetchone()
        return dict(row) if row else None


def get_auto_monitor_streamers() -> List[Dict[str, Any]]:
    """
    Liefert alle Streamer zurück, die in der Datenbank für die automatische Aufzeichnung
    markiert sind (`auto_monitor = 1` oder `is_tracking = 1`).
    Synchronisiert dabei `auto_monitor = 1`, damit der Status konsistent bleibt.
    """
    with get_db() as conn:
        conn.execute(
            "UPDATE streamers SET auto_monitor = 1 WHERE is_tracking = 1 AND auto_monitor = 0"
        )
        rows = conn.execute(
            "SELECT * FROM streamers WHERE auto_monitor = 1 OR is_tracking = 1 ORDER BY id ASC"
        ).fetchall()
        return [dict(r) for r in rows]


def upsert_streamer(
    username: str,
    display_name: Optional[str] = None,
    avatar_url: Optional[str] = None,
    room_id: Optional[str] = None,
    follower_count: Optional[int] = None,
    is_live: Optional[bool] = None,
    auto_monitor: Optional[bool] = None,
) -> Dict[str, Any]:
    clean_username = username.strip().lstrip("@").lower()
    if not clean_username:
        raise ValueError("Username darf nicht leer sein.")

    now = datetime.now().isoformat(timespec="seconds")
    with get_db() as conn:
        existing = conn.execute(
            "SELECT * FROM streamers WHERE LOWER(username) = LOWER(?)", (clean_username,)
        ).fetchone()

        if existing:
            new_display = display_name if display_name else existing["display_name"]
            new_avatar = avatar_url if avatar_url else existing["avatar_url"]
            new_room = room_id if room_id is not None else existing["room_id"]
            new_followers = (
                follower_count if follower_count is not None else existing["follower_count"]
            )
            new_live = int(is_live) if is_live is not None else existing["is_live"]
            new_auto = (
                int(auto_monitor) if auto_monitor is not None else existing["auto_monitor"]
            )
            conn.execute(
                """
                UPDATE streamers
                SET display_name = ?, avatar_url = ?, room_id = ?,
                    follower_count = ?, is_live = ?, auto_monitor = ?, last_seen_at = ?
                WHERE id = ?
                """,
                (
                    new_display,
                    new_avatar,
                    new_room,
                    new_followers,
                    new_live,
                    new_auto,
                    now,
                    existing["id"],
                ),
            )
            streamer_id = existing["id"]
        else:
            cursor = conn.execute(
                """
                INSERT INTO streamers (
                    username, display_name, avatar_url, room_id,
                    follower_count, is_live, auto_monitor, created_at, last_seen_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    clean_username,
                    display_name or clean_username,
                    avatar_url or "",
                    room_id or "",
                    follower_count or 0,
                    int(bool(is_live)),
                    int(bool(auto_monitor)),
                    now,
                    now,
                ),
            )
            streamer_id = cursor.lastrowid

        row = conn.execute(
            "SELECT * FROM streamers WHERE id = ?", (streamer_id,)
        ).fetchone()
        return dict(row)


def update_streamer_runtime_state(
    username: str,
    is_live: Optional[bool] = None,
    is_tracking: Optional[bool] = None,
    auto_monitor: Optional[bool] = None,
    room_id: Optional[str] = None,
    display_name: Optional[str] = None,
    avatar_url: Optional[str] = None,
    follower_count: Optional[int] = None,
    current_viewers: Optional[int] = None,
    last_error: Optional[str] = None,
) -> None:
    clean_username = username.strip().lstrip("@").lower()
    now = datetime.now().isoformat(timespec="seconds")
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM streamers WHERE LOWER(username) = LOWER(?)", (clean_username,)
        ).fetchone()
        if not row:
            return
        conn.execute(
            """
            UPDATE streamers
            SET is_live = COALESCE(?, is_live),
                is_tracking = COALESCE(?, is_tracking),
                auto_monitor = COALESCE(?, auto_monitor),
                room_id = COALESCE(?, room_id),
                display_name = COALESCE(?, display_name),
                avatar_url = COALESCE(?, avatar_url),
                follower_count = COALESCE(?, follower_count),
                current_viewers = COALESCE(?, current_viewers),
                last_error = COALESCE(?, last_error),
                last_seen_at = ?
            WHERE id = ?
            """,
            (
                int(is_live) if is_live is not None else None,
                int(is_tracking) if is_tracking is not None else None,
                int(auto_monitor) if auto_monitor is not None else None,
                room_id,
                display_name,
                avatar_url,
                follower_count,
                current_viewers,
                last_error,
                now,
                row["id"],
            ),
        )


def start_stream_session(
    streamer_id: int, room_id: str = "", title: str = ""
) -> int:
    now = datetime.now().isoformat(timespec="seconds")
    with get_db() as conn:
        active = conn.execute(
            """
            SELECT id, room_id FROM stream_sessions
            WHERE streamer_id = ? AND status = 'active'
            ORDER BY id DESC LIMIT 1
            """,
            (streamer_id,),
        ).fetchone()

        if active and (not room_id or active["room_id"] == room_id):
            if title:
                conn.execute(
                    "UPDATE stream_sessions SET title = ? WHERE id = ?",
                    (title, active["id"]),
                )
            return int(active["id"])

        conn.execute(
            """
            UPDATE stream_sessions
            SET status = 'ended', ended_at = ?
            WHERE streamer_id = ? AND status = 'active'
            """,
            (now, streamer_id),
        )

        cur = conn.execute(
            """
            INSERT INTO stream_sessions (
                streamer_id, room_id, title, started_at, status
            )
            VALUES (?, ?, ?, ?, 'active')
            """,
            (streamer_id, room_id or "", title or "", now),
        )
        return int(cur.lastrowid)


def update_stream_session_metrics(
    session_id: int,
    viewer_count: Optional[int] = None,
    room_fan_tickets: Optional[int] = None,
) -> None:
    with get_db() as conn:
        row = conn.execute(
            "SELECT peak_viewers, last_fan_tickets FROM stream_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if not row:
            return
        new_peak = max(int(row["peak_viewers"] or 0), int(viewer_count or 0))
        new_tickets = max(int(row["last_fan_tickets"] or 0), int(room_fan_tickets or 0))
        conn.execute(
            """
            UPDATE stream_sessions
            SET peak_viewers = ?, last_fan_tickets = ?
            WHERE id = ?
            """,
            (new_peak, new_tickets, session_id),
        )


def end_stream_session(streamer_id: int, session_id: Optional[int] = None) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with get_db() as conn:
        if session_id:
            conn.execute(
                "UPDATE stream_sessions SET status = 'ended', ended_at = ? WHERE id = ?",
                (now, session_id),
            )
        else:
            conn.execute(
                """
                UPDATE stream_sessions
                SET status = 'ended', ended_at = ?
                WHERE streamer_id = ? AND status = 'active'
                """,
                (now, streamer_id),
            )


def record_gift_event(
    streamer_id: int,
    sender_username: str,
    gift_name: str,
    diamond_count: int,
    repeat_count: int = 1,
    sender_nickname: Optional[str] = None,
    sender_user_id: str = "",
    is_super_fan: bool = False,
    gift_id: int = 0,
    gift_icon_url: str = "",
    combo_count: int = 1,
    group_id: str = "",
    room_fan_tickets: int = 0,
    event_uid: Optional[str] = None,
    session_id: Optional[int] = None,
    source: str = "tiktoklive",
    created_at: Optional[str] = None,
) -> Tuple[Optional[Dict[str, Any]], bool]:
    cfg = get_settings()
    diamond_count = max(0, int(diamond_count))
    repeat_count = max(1, int(repeat_count))
    total_coins = diamond_count * repeat_count

    usd_net = round(total_coins * cfg["usd_per_diamond"], 4)
    eur_net = round(usd_net * cfg["usd_to_eur_rate"], 4)
    usd_gross = round(total_coins * cfg["gross_usd_per_coin"], 4)
    eur_gross = round(usd_gross * cfg["usd_to_eur_rate"], 4)

    ts = created_at or datetime.now().isoformat(timespec="seconds")

    with get_db() as conn:
        if event_uid:
            existing = conn.execute(
                "SELECT id FROM gift_events WHERE event_uid = ?", (event_uid,)
            ).fetchone()
            if existing:
                return None, False

        cur = conn.execute(
            """
            INSERT INTO gift_events (
                streamer_id, session_id, event_uid,
                sender_user_id, sender_username, sender_nickname, is_super_fan,
                gift_id, gift_name, gift_icon_url,
                diamond_count, repeat_count, combo_count, group_id, room_fan_tickets,
                total_coins, usd_net, eur_net, usd_gross, eur_gross,
                source, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                streamer_id,
                session_id,
                event_uid,
                str(sender_user_id or ""),
                sender_username,
                sender_nickname or sender_username,
                int(bool(is_super_fan)),
                gift_id,
                gift_name,
                gift_icon_url,
                diamond_count,
                repeat_count,
                combo_count,
                str(group_id or ""),
                int(room_fan_tickets or 0),
                total_coins,
                usd_net,
                eur_net,
                usd_gross,
                eur_gross,
                source,
                ts,
            ),
        )
        conn.execute(
            "UPDATE streamers SET last_seen_at = ? WHERE id = ?",
            (ts, streamer_id),
        )
        if session_id and room_fan_tickets > 0:
            conn.execute(
                """
                UPDATE stream_sessions
                SET last_fan_tickets = MAX(last_fan_tickets, ?)
                WHERE id = ?
                """,
                (int(room_fan_tickets), session_id),
            )

        row = conn.execute(
            """
            SELECT g.*, s.username AS streamer_username, s.display_name AS streamer_display_name
            FROM gift_events g
            JOIN streamers s ON s.id = g.streamer_id
            WHERE g.id = ?
            """,
            (cur.lastrowid,),
        ).fetchone()
        invalidate_overview_cache()
        return (dict(row) if row else None), True


def delete_streamer(streamer_id: int) -> bool:
    with get_db() as conn:
        cur = conn.execute("DELETE FROM streamers WHERE id = ?", (streamer_id,))
        return cur.rowcount > 0


def _get_period_cutoff(period: str) -> Optional[str]:
    now = datetime.now()
    if period == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0).strftime("%Y-%m-%d %H:%M:%S")
    if period == "24h":
        return (now - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
    if period == "7d":
        return (now - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
    if period == "30d":
        return (now - timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")
    return None


_overview_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_overview_cache_lock = threading.Lock()
_OVERVIEW_CACHE_TTL = 2.5  # 2.5s TTL verhindert Doppel-Berechnungen bei raschen/parallelen Polls


def invalidate_overview_cache() -> None:
    with _overview_cache_lock:
        _overview_cache.clear()


def get_dashboard_overview(period: str = "all", force_refresh: bool = False) -> Dict[str, Any]:
    now = time.monotonic()
    if not force_refresh:
        with _overview_cache_lock:
            cached = _overview_cache.get(period)
            if cached and (now - cached[0]) < _OVERVIEW_CACHE_TTL:
                return cached[1].copy()

    cutoff = _get_period_cutoff(period)
    cfg = get_settings()

    with get_db() as conn:
        if cutoff:
            streamer_rows = conn.execute(
                """
                SELECT
                    s.*,
                    COALESCE(SUM(g.total_coins), 0) AS total_coins,
                    COUNT(g.id) AS gift_events_count,
                    COALESCE(SUM(g.repeat_count), 0) AS total_gifts_sent,
                    COUNT(DISTINCT g.sender_username) AS unique_gifters
                FROM streamers s
                LEFT JOIN gift_events g
                    ON g.streamer_id = s.id AND g.created_at >= ?
                GROUP BY s.id
                ORDER BY total_coins DESC, s.username ASC
                """,
                (cutoff,),
            ).fetchall()
        else:
            streamer_rows = conn.execute(
                """
                SELECT
                    s.*,
                    COALESCE(SUM(g.total_coins), 0) AS total_coins,
                    COUNT(g.id) AS gift_events_count,
                    COALESCE(SUM(g.repeat_count), 0) AS total_gifts_sent,
                    COUNT(DISTINCT g.sender_username) AS unique_gifters
                FROM streamers s
                LEFT JOIN gift_events g
                    ON g.streamer_id = s.id
                GROUP BY s.id
                ORDER BY total_coins DESC, s.username ASC
                """
            ).fetchall()

        streamers: List[Dict[str, Any]] = []
        totals = {
            "streamer_count": len(streamer_rows),
            "live_count": 0,
            "tracking_count": 0,
            "total_coins": 0,
            "usd_net": 0.0,
            "eur_net": 0.0,
            "usd_gross": 0.0,
            "eur_gross": 0.0,
            "total_gifts_sent": 0,
            "gift_events_count": 0,
        }

        for r in streamer_rows:
            d = dict(r)
            coins = int(d["total_coins"] or 0)
            d["usd_net"] = round(coins * cfg["usd_per_diamond"], 2)
            d["eur_net"] = round(d["usd_net"] * cfg["usd_to_eur_rate"], 2)
            d["usd_gross"] = round(coins * cfg["gross_usd_per_coin"], 2)
            d["eur_gross"] = round(d["usd_gross"] * cfg["usd_to_eur_rate"], 2)

            top_gift = conn.execute(
                """
                SELECT gift_name, SUM(total_coins) AS coins, SUM(repeat_count) AS count
                FROM gift_events
                WHERE streamer_id = ? AND (? IS NULL OR created_at >= ?)
                GROUP BY gift_name
                ORDER BY coins DESC
                LIMIT 1
                """,
                (d["id"], cutoff, cutoff),
            ).fetchone()
            d["top_gift"] = dict(top_gift) if top_gift else None

            top_gifter = conn.execute(
                """
                SELECT sender_username, MAX(sender_nickname) AS sender_nickname, SUM(total_coins) AS coins
                FROM gift_events
                WHERE streamer_id = ? AND (? IS NULL OR created_at >= ?)
                GROUP BY sender_username
                ORDER BY coins DESC
                LIMIT 1
                """,
                (d["id"], cutoff, cutoff),
            ).fetchone()
            d["top_gifter"] = dict(top_gifter) if top_gifter else None

            active_sess = conn.execute(
                """
                SELECT id, room_id, started_at, peak_viewers, last_fan_tickets
                FROM stream_sessions
                WHERE streamer_id = ? AND status = 'active'
                ORDER BY id DESC LIMIT 1
                """,
                (d["id"],),
            ).fetchone()
            d["active_session"] = dict(active_sess) if active_sess else None

            streamers.append(d)

            totals["live_count"] += int(bool(d["is_live"]))
            totals["tracking_count"] += int(bool(d["is_tracking"]))
            totals["total_coins"] += coins
            totals["usd_net"] = round(totals["usd_net"] + d["usd_net"], 2)
            totals["eur_net"] = round(totals["eur_net"] + d["eur_net"], 2)
            totals["usd_gross"] = round(totals["usd_gross"] + d["usd_gross"], 2)
            totals["eur_gross"] = round(totals["eur_gross"] + d["eur_gross"], 2)
            totals["total_gifts_sent"] += int(d["total_gifts_sent"] or 0)
            totals["gift_events_count"] += int(d["gift_events_count"] or 0)

        if cutoff:
            recent_rows = conn.execute(
                """
                SELECT g.*, s.username AS streamer_username, s.display_name AS streamer_display_name
                FROM gift_events g
                JOIN streamers s ON s.id = g.streamer_id
                WHERE g.created_at >= ?
                ORDER BY g.created_at DESC, g.id DESC
                LIMIT 50
                """,
                (cutoff,),
            ).fetchall()
        else:
            recent_rows = conn.execute(
                """
                SELECT g.*, s.username AS streamer_username, s.display_name AS streamer_display_name
                FROM gift_events g
                JOIN streamers s ON s.id = g.streamer_id
                ORDER BY g.created_at DESC, g.id DESC
                LIMIT 50
                """
            ).fetchall()

        recent_gifts = []
        for r in recent_rows:
            gd = dict(r)
            coins = int(gd["total_coins"] or 0)
            gd["usd_net"] = round(coins * cfg["usd_per_diamond"], 2)
            gd["eur_net"] = round(gd["usd_net"] * cfg["usd_to_eur_rate"], 2)
            recent_gifts.append(gd)

    res = {
        "settings": cfg,
        "period": period,
        "totals": totals,
        "streamers": streamers,
        "recent_gifts": recent_gifts,
        "telegram_users": list_telegram_users(),
    }
    with _overview_cache_lock:
        _overview_cache[period] = (now, res)
    return res


def get_streamer_detail(streamer_id: int, period: str = "all") -> Optional[Dict[str, Any]]:
    cutoff = _get_period_cutoff(period)
    cfg = get_settings()

    with get_db() as conn:
        streamer = conn.execute(
            "SELECT * FROM streamers WHERE id = ?", (streamer_id,)
        ).fetchone()
        if not streamer:
            return None

        s_dict = dict(streamer)

        gift_breakdown = conn.execute(
            """
            SELECT
                MAX(gift_id) AS gift_id,
                gift_name,
                diamond_count,
                SUM(repeat_count) AS total_quantity,
                SUM(total_coins) AS total_coins,
                COUNT(id) AS events_count
            FROM gift_events
            WHERE streamer_id = ? AND (? IS NULL OR created_at >= ?)
            GROUP BY gift_name, diamond_count
            ORDER BY total_coins DESC
            """,
            (streamer_id, cutoff, cutoff),
        ).fetchall()

        gifts_list = []
        total_coins = 0
        for g in gift_breakdown:
            gd = dict(g)
            c = int(gd["total_coins"] or 0)
            total_coins += c
            gd["usd_net"] = round(c * cfg["usd_per_diamond"], 2)
            gd["eur_net"] = round(gd["usd_net"] * cfg["usd_to_eur_rate"], 2)
            gifts_list.append(gd)

        top_gifters_rows = conn.execute(
            """
            SELECT
                sender_username,
                MAX(sender_nickname) AS sender_nickname,
                MAX(is_super_fan) AS is_super_fan,
                SUM(total_coins) AS total_coins,
                SUM(repeat_count) AS gifts_sent,
                COUNT(id) AS transactions
            FROM gift_events
            WHERE streamer_id = ? AND (? IS NULL OR created_at >= ?)
            GROUP BY sender_username
            ORDER BY total_coins DESC
            LIMIT 15
            """,
            (streamer_id, cutoff, cutoff),
        ).fetchall()

        top_gifters = []
        for tg in top_gifters_rows:
            tgd = dict(tg)
            c = int(tgd["total_coins"] or 0)
            tgd["usd_net"] = round(c * cfg["usd_per_diamond"], 2)
            tgd["eur_net"] = round(tgd["usd_net"] * cfg["usd_to_eur_rate"], 2)
            top_gifters.append(tgd)

        sessions_rows = conn.execute(
            """
            SELECT
                ss.*,
                COALESCE(SUM(g.total_coins), 0) AS session_coins,
                COUNT(g.id) AS gift_events
            FROM stream_sessions ss
            LEFT JOIN gift_events g ON g.session_id = ss.id
            WHERE ss.streamer_id = ?
            GROUP BY ss.id
            ORDER BY ss.id DESC
            LIMIT 20
            """,
            (streamer_id,),
        ).fetchall()

        sessions = []
        for sr in sessions_rows:
            sd = dict(sr)
            c = int(sd["session_coins"] or 0)
            sd["usd_net"] = round(c * cfg["usd_per_diamond"], 2)
            sd["eur_net"] = round(sd["usd_net"] * cfg["usd_to_eur_rate"], 2)
            sessions.append(sd)

        recent_rows = conn.execute(
            """
            SELECT *
            FROM gift_events
            WHERE streamer_id = ? AND (? IS NULL OR created_at >= ?)
            ORDER BY created_at DESC, id DESC
            LIMIT 50
            """,
            (streamer_id, cutoff, cutoff),
        ).fetchall()

        recent_events = []
        for r in recent_rows:
            rd = dict(r)
            c = int(rd["total_coins"] or 0)
            rd["usd_net"] = round(c * cfg["usd_per_diamond"], 2)
            rd["eur_net"] = round(rd["usd_net"] * cfg["usd_to_eur_rate"], 2)
            recent_events.append(rd)

        usd_net = round(total_coins * cfg["usd_per_diamond"], 2)
        eur_net = round(usd_net * cfg["usd_to_eur_rate"], 2)
        usd_gross = round(total_coins * cfg["gross_usd_per_coin"], 2)
        eur_gross = round(usd_gross * cfg["usd_to_eur_rate"], 2)

        return {
            "streamer": s_dict,
            "summary": {
                "total_coins": total_coins,
                "usd_net": usd_net,
                "eur_net": eur_net,
                "usd_gross": usd_gross,
                "eur_gross": eur_gross,
            },
            "gift_breakdown": gifts_list,
            "top_gifters": top_gifters,
            "sessions": sessions,
            "recent_events": recent_events,
        }


def get_analytics_data(streamer_id: Optional[int] = None, period: str = "all") -> Dict[str, Any]:
    """
    Liefert detaillierte Analytics und aggregierte Kennzahlen für Charts:
    - Gesamt-KPIs (Netto/Brutto, Coins, Gifts, Unique Gifters, Averages)
    - Whale-Konzentrationsmetriken (Top 1, Top 3, Top 5 Spenderanteil)
    - Chronologischer Einnahmen-Verlauf (stündlich bei 24h/today, täglich bei 7d/30d/all)
    - Multi-Streamer-Timeline-Vergleich für Top-Streamer (wenn kein Einzelstreamer gewählt)
    - Tageszeit-Aktivitätsmuster (00:00 - 23:00 Uhr)
    - Top Geschenke Verteilung (Doughnut/Pie & Tabelle)
    - Top Spender & Supporter Ranking (Bar-Chart & Tabelle)
    - Streamer-Vergleich (Ranking & Einnahmenverteilung)
    - Stream-Sessions Historie mit berechneter Dauer und Hourly Run-Rate (Coins/h)
    """
    cutoff = _get_period_cutoff(period)
    cfg = get_settings()

    with get_db() as conn:
        # 1. Streamer-Details, falls ein spezifischer Streamer gewählt wurde
        selected_streamer = None
        if streamer_id:
            s_row = conn.execute(
                "SELECT * FROM streamers WHERE id = ?", (streamer_id,)
            ).fetchone()
            if s_row:
                selected_streamer = dict(s_row)
            else:
                streamer_id = None

        # 2. Aggregierte Gesamt-Metriken im gewählten Zeitraum & Scope
        agg_row = conn.execute(
            """
            SELECT
                COALESCE(SUM(total_coins), 0) AS total_coins,
                COALESCE(SUM(repeat_count), 0) AS total_gifts_sent,
                COUNT(id) AS gift_events_count,
                COUNT(DISTINCT sender_username) AS unique_gifters
            FROM gift_events
            WHERE (? IS NULL OR streamer_id = ?)
              AND (? IS NULL OR created_at >= ?)
            """,
            (streamer_id, streamer_id, cutoff, cutoff),
        ).fetchone()

        total_coins = int(agg_row["total_coins"] or 0)
        total_gifts = int(agg_row["total_gifts_sent"] or 0)
        gift_events_cnt = int(agg_row["gift_events_count"] or 0)
        unique_gifters = int(agg_row["unique_gifters"] or 0)

        usd_net = round(total_coins * cfg["usd_per_diamond"], 2)
        eur_net = round(usd_net * cfg["usd_to_eur_rate"], 2)
        usd_gross = round(total_coins * cfg["gross_usd_per_coin"], 2)
        eur_gross = round(usd_gross * cfg["usd_to_eur_rate"], 2)

        avg_coins_per_gift = round(total_coins / total_gifts, 1) if total_gifts > 0 else 0.0
        avg_coins_per_gifter = round(total_coins / unique_gifters, 1) if unique_gifters > 0 else 0.0
        avg_eur_per_gifter = round(eur_net / unique_gifters, 2) if unique_gifters > 0 else 0.0

        # 3. Top Spender & Supporter-Ranking sowie Whale-Konzentration
        top_gifters_rows = conn.execute(
            """
            SELECT
                sender_username,
                MAX(sender_nickname) AS sender_nickname,
                MAX(is_super_fan) AS is_super_fan,
                SUM(total_coins) AS total_coins,
                SUM(repeat_count) AS gifts_sent,
                COUNT(id) AS transactions
            FROM gift_events
            WHERE (? IS NULL OR streamer_id = ?)
              AND (? IS NULL OR created_at >= ?)
            GROUP BY sender_username
            ORDER BY total_coins DESC
            LIMIT 25
            """,
            (streamer_id, streamer_id, cutoff, cutoff),
        ).fetchall()

        top_gifters = []
        top1_coins = 0
        top3_coins = 0
        top5_coins = 0
        for idx, tg in enumerate(top_gifters_rows):
            c = int(tg["total_coins"] or 0)
            u_net = round(c * cfg["usd_per_diamond"], 2)
            e_net = round(u_net * cfg["usd_to_eur_rate"], 2)
            pct = round((c / total_coins * 100), 1) if total_coins > 0 else 0.0
            if idx == 0:
                top1_coins += c
            if idx < 3:
                top3_coins += c
            if idx < 5:
                top5_coins += c
            top_gifters.append({
                "rank": idx + 1,
                "sender_username": tg["sender_username"],
                "sender_nickname": tg["sender_nickname"] or tg["sender_username"],
                "is_super_fan": bool(tg["is_super_fan"]),
                "total_coins": c,
                "usd_net": u_net,
                "eur_net": e_net,
                "gifts_sent": int(tg["gifts_sent"] or 0),
                "transactions": int(tg["transactions"] or 0),
                "pct_of_total": pct,
            })

        whale_share_top1 = round((top1_coins / total_coins * 100), 1) if total_coins > 0 else 0.0
        whale_share_top3 = round((top3_coins / total_coins * 100), 1) if total_coins > 0 else 0.0
        whale_share_top5 = round((top5_coins / total_coins * 100), 1) if total_coins > 0 else 0.0

        # 4. Top Geschenke-Aufschlüsselung
        top_gifts_rows = conn.execute(
            """
            SELECT
                MAX(gift_id) AS gift_id,
                gift_name,
                diamond_count,
                SUM(repeat_count) AS total_quantity,
                SUM(total_coins) AS total_coins,
                COUNT(id) AS events_count
            FROM gift_events
            WHERE (? IS NULL OR streamer_id = ?)
              AND (? IS NULL OR created_at >= ?)
            GROUP BY gift_name, diamond_count
            ORDER BY total_coins DESC
            LIMIT 20
            """,
            (streamer_id, streamer_id, cutoff, cutoff),
        ).fetchall()

        top_gifts = []
        for g in top_gifts_rows:
            c = int(g["total_coins"] or 0)
            u_net = round(c * cfg["usd_per_diamond"], 2)
            e_net = round(u_net * cfg["usd_to_eur_rate"], 2)
            pct = round((c / total_coins * 100), 1) if total_coins > 0 else 0.0
            top_gifts.append({
                "gift_id": g["gift_id"],
                "gift_name": g["gift_name"],
                "diamond_count": int(g["diamond_count"] or 0),
                "total_quantity": int(g["total_quantity"] or 0),
                "total_coins": c,
                "usd_net": u_net,
                "eur_net": e_net,
                "events_count": int(g["events_count"] or 0),
                "pct_of_total": pct,
            })

        # 5. Tageszeit-Aktivitätsmuster (00:00 - 23:00 Uhr)
        tod_rows = conn.execute(
            """
            SELECT
                CAST(SUBSTR(created_at, 12, 2) AS INTEGER) AS hour_of_day,
                SUM(total_coins) AS coins,
                COUNT(id) AS events_count
            FROM gift_events
            WHERE (? IS NULL OR streamer_id = ?)
              AND (? IS NULL OR created_at >= ?)
            GROUP BY CAST(SUBSTR(created_at, 12, 2) AS INTEGER)
            ORDER BY hour_of_day ASC
            """,
            (streamer_id, streamer_id, cutoff, cutoff),
        ).fetchall()

        tod_map = {int(r["hour_of_day"]): (int(r["coins"] or 0), int(r["events_count"] or 0)) for r in tod_rows}
        time_of_day = []
        for h in range(24):
            c, ev = tod_map.get(h, (0, 0))
            u_net = round(c * cfg["usd_per_diamond"], 2)
            e_net = round(u_net * cfg["usd_to_eur_rate"], 2)
            time_of_day.append({
                "hour": h,
                "label": f"{h:02d}:00",
                "coins": c,
                "eur_net": e_net,
                "events_count": ev,
            })

        # 6. Chronologischer Einnahmen-Verlauf (Timeline)
        is_hourly = period in ("24h", "today")
        substr_len = 13 if is_hourly else 10

        timeline_rows = conn.execute(
            f"""
            SELECT
                SUBSTR(created_at, 1, {substr_len}) AS bucket,
                COALESCE(SUM(total_coins), 0) AS coins,
                COUNT(id) AS events_count,
                COUNT(DISTINCT sender_username) AS unique_gifters
            FROM gift_events
            WHERE (? IS NULL OR streamer_id = ?)
              AND (? IS NULL OR created_at >= ?)
            GROUP BY SUBSTR(created_at, 1, {substr_len})
            ORDER BY bucket ASC
            """,
            (streamer_id, streamer_id, cutoff, cutoff),
        ).fetchall()

        timeline = []
        for tr in timeline_rows:
            b = tr["bucket"]
            c = int(tr["coins"] or 0)
            u_net = round(c * cfg["usd_per_diamond"], 2)
            e_net = round(u_net * cfg["usd_to_eur_rate"], 2)
            u_gross = round(c * cfg["gross_usd_per_coin"], 2)
            e_gross = round(u_gross * cfg["usd_to_eur_rate"], 2)
            ev = int(tr["events_count"] or 0)
            ug = int(tr["unique_gifters"] or 0)
            avg_coins = round(c / ev, 1) if ev > 0 else 0.0
            avg_eur = round(e_net / ug, 2) if ug > 0 else 0.0

            if is_hourly:
                parts = b.replace("T", " ").split(" ")
                time_part = f"{parts[1]}:00" if len(parts) > 1 else b
                label = time_part if period == "today" else f"{parts[0][5:]} {time_part}"
            else:
                label = f"{b[8:10]}.{b[5:7]}." if len(b) >= 10 else b

            timeline.append({
                "bucket": b,
                "label": label,
                "coins": c,
                "eur_net": e_net,
                "usd_net": u_net,
                "eur_gross": e_gross,
                "usd_gross": u_gross,
                "events_count": ev,
                "unique_gifters": ug,
                "avg_coins_per_gift": avg_coins,
                "avg_eur_per_gifter": avg_eur,
            })

        # 7. Streamer Ranking & Vergleich
        streamer_ranking_rows = conn.execute(
            """
            SELECT
                s.id,
                s.username,
                s.display_name,
                s.avatar_url,
                s.follower_count,
                s.current_viewers,
                s.is_live,
                s.is_tracking,
                COALESCE(SUM(g.total_coins), 0) AS total_coins,
                COUNT(g.id) AS gift_events_count,
                COALESCE(SUM(g.repeat_count), 0) AS total_gifts_sent,
                COUNT(DISTINCT g.sender_username) AS unique_gifters
            FROM streamers s
            LEFT JOIN gift_events g
                ON g.streamer_id = s.id AND (? IS NULL OR g.created_at >= ?)
            GROUP BY s.id
            ORDER BY total_coins DESC, s.username ASC
            """,
            (cutoff, cutoff),
        ).fetchall()

        streamers_ranking = []
        top_streamer_ids = []
        for sr in streamer_ranking_rows:
            c = int(sr["total_coins"] or 0)
            u_net = round(c * cfg["usd_per_diamond"], 2)
            e_net = round(u_net * cfg["usd_to_eur_rate"], 2)
            pct = round((c / total_coins * 100), 1) if (total_coins > 0 and not streamer_id) else (100.0 if c > 0 else 0.0)
            streamers_ranking.append({
                "id": sr["id"],
                "username": sr["username"],
                "display_name": sr["display_name"] or sr["username"],
                "avatar_url": sr["avatar_url"] or "",
                "follower_count": int(sr["follower_count"] or 0),
                "current_viewers": int(sr["current_viewers"] or 0),
                "is_live": bool(sr["is_live"]),
                "is_tracking": bool(sr["is_tracking"]),
                "total_coins": c,
                "eur_net": e_net,
                "usd_net": u_net,
                "gift_events_count": int(sr["gift_events_count"] or 0),
                "total_gifts_sent": int(sr["total_gifts_sent"] or 0),
                "unique_gifters": int(sr["unique_gifters"] or 0),
                "pct_of_total": pct,
            })
            if c > 0 and len(top_streamer_ids) < 5:
                top_streamer_ids.append(sr["id"])

        # 8. Multi-Streamer-Timeline-Vergleich für die Top 5 Streamer (wenn Gesamtansicht)
        multi_streamer_datasets = []
        if not streamer_id and top_streamer_ids and timeline:
            buckets = [t["bucket"] for t in timeline]
            for sid in top_streamer_ids:
                s_meta = next((s for s in streamers_ranking if s["id"] == sid), None)
                if not s_meta:
                    continue
                s_rows = conn.execute(
                    f"""
                    SELECT
                        SUBSTR(created_at, 1, {substr_len}) AS bucket,
                        COALESCE(SUM(total_coins), 0) AS coins
                    FROM gift_events
                    WHERE streamer_id = ? AND (? IS NULL OR created_at >= ?)
                    GROUP BY SUBSTR(created_at, 1, {substr_len})
                    """,
                    (sid, cutoff, cutoff),
                ).fetchall()
                s_map = {r["bucket"]: int(r["coins"] or 0) for r in s_rows}
                series_data = [s_map.get(b, 0) for b in buckets]
                multi_streamer_datasets.append({
                    "streamer_id": sid,
                    "username": s_meta["username"],
                    "display_name": s_meta["display_name"],
                    "data": series_data,
                })

        # 9. Aufgezeichnete Sessions & Hourly Run-Rates
        sessions_rows = conn.execute(
            """
            SELECT
                ss.*,
                s.username AS streamer_username,
                s.display_name AS streamer_display_name,
                COALESCE(SUM(g.total_coins), 0) AS session_coins,
                COUNT(g.id) AS session_gifts
            FROM stream_sessions ss
            JOIN streamers s ON s.id = ss.streamer_id
            LEFT JOIN gift_events g ON g.session_id = ss.id
            WHERE (? IS NULL OR ss.streamer_id = ?)
              AND (? IS NULL OR ss.started_at >= ?)
            GROUP BY ss.id
            ORDER BY ss.started_at DESC, ss.id DESC
            LIMIT 25
            """,
            (streamer_id, streamer_id, cutoff, cutoff),
        ).fetchall()

        now_dt = datetime.now()
        sessions = []
        total_session_minutes = 0
        for sr in sessions_rows:
            c = int(sr["session_coins"] or 0)
            u_net = round(c * cfg["usd_per_diamond"], 2)
            e_net = round(u_net * cfg["usd_to_eur_rate"], 2)

            start_str = sr["started_at"]
            end_str = sr["ended_at"]
            duration_mins = 0
            try:
                s_dt = datetime.fromisoformat(start_str)
                e_dt = datetime.fromisoformat(end_str) if end_str else now_dt
                duration_mins = max(1, int(round((e_dt - s_dt).total_seconds() / 60)))
            except Exception:
                duration_mins = 0

            total_session_minutes += duration_mins
            coins_per_hour = round(c / (duration_mins / 60)) if duration_mins > 0 else c

            sessions.append({
                "id": sr["id"],
                "streamer_id": sr["streamer_id"],
                "streamer_username": sr["streamer_username"],
                "streamer_display_name": sr["streamer_display_name"] or sr["streamer_username"],
                "room_id": sr["room_id"],
                "title": sr["title"],
                "started_at": sr["started_at"],
                "ended_at": sr["ended_at"],
                "duration_minutes": duration_mins,
                "peak_viewers": int(sr["peak_viewers"] or 0),
                "status": sr["status"],
                "session_coins": c,
                "eur_net": e_net,
                "usd_net": u_net,
                "session_gifts": int(sr["session_gifts"] or 0),
                "coins_per_hour": coins_per_hour,
            })

    return {
        "period": period,
        "selected_streamer_id": streamer_id,
        "selected_streamer": selected_streamer,
        "totals": {
            "total_coins": total_coins,
            "eur_net": eur_net,
            "usd_net": usd_net,
            "eur_gross": eur_gross,
            "usd_gross": usd_gross,
            "total_gifts_sent": total_gifts,
            "gift_events_count": gift_events_cnt,
            "unique_gifters": unique_gifters,
            "avg_coins_per_gift": avg_coins_per_gift,
            "avg_coins_per_gifter": avg_coins_per_gifter,
            "avg_eur_per_gifter": avg_eur_per_gifter,
            "whale_share_top1_pct": whale_share_top1,
            "whale_share_top3_pct": whale_share_top3,
            "whale_share_top5_pct": whale_share_top5,
            "sessions_count": len(sessions),
            "total_stream_minutes": total_session_minutes,
        },
        "timeline": timeline,
        "multi_streamer_datasets": multi_streamer_datasets,
        "time_of_day": time_of_day,
        "top_gifts": top_gifts,
        "top_gifters": top_gifters,
        "streamers_ranking": streamers_ranking,
        "sessions": sessions,
    }


def build_streamer_bot_report(
    streamer_row: Dict[str, Any],
    hours: int = 24,
    is_tracking_active: bool = False,
    worker_state: str = "stopped",
) -> Dict[str, Any]:
    cfg = get_settings()
    cutoff = (datetime.now() - timedelta(hours=max(1, hours))).isoformat(timespec="seconds")
    sid = int(streamer_row["id"])

    with get_db() as conn:
        period_agg = conn.execute(
            """
            SELECT
                COALESCE(SUM(total_coins), 0) AS coins,
                COALESCE(SUM(repeat_count), 0) AS gifts_sent,
                COUNT(id) AS gift_events,
                COUNT(DISTINCT sender_username) AS unique_gifters
            FROM gift_events
            WHERE streamer_id = ? AND created_at >= ?
            """,
            (sid, cutoff),
        ).fetchone()

        alltime_agg = conn.execute(
            """
            SELECT COALESCE(SUM(total_coins), 0) AS coins
            FROM gift_events
            WHERE streamer_id = ?
            """,
            (sid,),
        ).fetchone()

        sess_agg = conn.execute(
            """
            SELECT
                COUNT(id) AS sessions_count,
                COALESCE(MAX(peak_viewers), 0) AS max_peak_viewers
            FROM stream_sessions
            WHERE streamer_id = ? AND (started_at >= ? OR status = 'active')
            """,
            (sid, cutoff),
        ).fetchone()

        top_gifts_rows = conn.execute(
            """
            SELECT
                gift_name,
                diamond_count,
                SUM(repeat_count) AS total_quantity,
                SUM(total_coins) AS total_coins,
                COUNT(id) AS events_count
            FROM gift_events
            WHERE streamer_id = ? AND created_at >= ?
            GROUP BY gift_name, diamond_count
            ORDER BY total_coins DESC
            LIMIT 5
            """,
            (sid, cutoff),
        ).fetchall()

        top_gifters_rows = conn.execute(
            """
            SELECT
                sender_username,
                MAX(sender_nickname) AS sender_nickname,
                MAX(is_super_fan) AS is_super_fan,
                SUM(total_coins) AS total_coins,
                SUM(repeat_count) AS gifts_sent,
                COUNT(id) AS transactions
            FROM gift_events
            WHERE streamer_id = ? AND created_at >= ?
            GROUP BY sender_username
            ORDER BY total_coins DESC
            LIMIT 5
            """,
            (sid, cutoff),
        ).fetchall()

    p_coins = int(period_agg["coins"] or 0)
    p_usd_net = round(p_coins * cfg["usd_per_diamond"], 2)
    p_eur_net = round(p_usd_net * cfg["usd_to_eur_rate"], 2)
    p_usd_gross = round(p_coins * cfg["gross_usd_per_coin"], 2)
    p_eur_gross = round(p_usd_gross * cfg["usd_to_eur_rate"], 2)

    all_coins = int(alltime_agg["coins"] or 0)
    all_usd_net = round(all_coins * cfg["usd_per_diamond"], 2)
    all_eur_net = round(all_usd_net * cfg["usd_to_eur_rate"], 2)

    top_gifts = []
    for g in top_gifts_rows:
        c = int(g["total_coins"] or 0)
        u_net = round(c * cfg["usd_per_diamond"], 2)
        e_net = round(u_net * cfg["usd_to_eur_rate"], 2)
        top_gifts.append(
            {
                "gift_name": g["gift_name"],
                "diamond_count": int(g["diamond_count"] or 0),
                "total_quantity": int(g["total_quantity"] or 0),
                "total_coins": c,
                "events_count": int(g["events_count"] or 0),
                "usd_net": u_net,
                "eur_net": e_net,
            }
        )

    top_gifters = []
    for tg in top_gifters_rows:
        c = int(tg["total_coins"] or 0)
        u_net = round(c * cfg["usd_per_diamond"], 2)
        e_net = round(u_net * cfg["usd_to_eur_rate"], 2)
        top_gifters.append(
            {
                "sender_username": tg["sender_username"],
                "sender_nickname": tg["sender_nickname"] or tg["sender_username"],
                "is_super_fan": bool(tg["is_super_fan"]),
                "total_coins": c,
                "gifts_sent": int(tg["gifts_sent"] or 0),
                "transactions": int(tg["transactions"] or 0),
                "usd_net": u_net,
                "eur_net": e_net,
            }
        )

    uname = streamer_row["username"]
    dname = streamer_row["display_name"] or uname
    live_icon = "🟢 LIVE" if streamer_row.get("is_live") else "⚪ Offline"
    top_gift_str = (
        f"{top_gifts[0]['gift_name']} ({top_gifts[0]['total_coins']:,} Coins)"
        if top_gifts
        else "Keine"
    )
    top_gifter_str = (
        f"@{top_gifters[0]['sender_username']} ({top_gifters[0]['total_coins']:,} Coins)"
        if top_gifters
        else "Keine"
    )

    telegram_text = (
        f"📊 *{dname}* (@{uname}) [{live_icon}]\n"
        f"• Zeitraum ({hours}h): *{p_eur_net:,.2f} €* (${p_usd_net:,.2f}) | *{p_coins:,} Coins*\n"
        f"• Brutto-Kaufwert ({hours}h): {p_eur_gross:,.2f} € | Gifts: {int(period_agg['gifts_sent'] or 0)} ({int(period_agg['unique_gifters'] or 0)} Gifter)\n"
        f"• Top Gift: {top_gift_str}\n"
        f"• Top Spender: {top_gifter_str}\n"
        f"• Gesamt (All-Time): {all_eur_net:,.2f} € ({all_coins:,} Coins)"
    )

    return {
        "streamer_id": sid,
        "username": uname,
        "display_name": dname,
        "is_live": bool(streamer_row.get("is_live")),
        "is_tracking_active": is_tracking_active,
        "worker_state": worker_state,
        "current_viewers": int(streamer_row.get("current_viewers") or 0),
        "follower_count": int(streamer_row.get("follower_count") or 0),
        "period_hours": hours,
        "period_coins": p_coins,
        "period_gifts_sent": int(period_agg["gifts_sent"] or 0),
        "period_gift_events": int(period_agg["gift_events"] or 0),
        "period_unique_gifters": int(period_agg["unique_gifters"] or 0),
        "period_usd_net": p_usd_net,
        "period_eur_net": p_eur_net,
        "period_usd_gross": p_usd_gross,
        "period_eur_gross": p_eur_gross,
        "period_sessions_count": int(sess_agg["sessions_count"] or 0),
        "period_peak_viewers": max(
            int(sess_agg["max_peak_viewers"] or 0),
            int(streamer_row.get("current_viewers") or 0),
        ),
        "alltime_coins": all_coins,
        "alltime_usd_net": all_usd_net,
        "alltime_eur_net": all_eur_net,
        "top_gifts": top_gifts,
        "top_gifters": top_gifters,
        "telegram_text": telegram_text,
    }


def record_battle_start(
    streamer_id: int,
    battle_id: str,
    opponent_username: str = "",
    opponent_display_name: str = "",
    opponent_avatar_url: str = "",
    opponent_user_id: str = "",
    session_id: Optional[int] = None,
    duration_seconds: int = 300,
    started_at: Optional[str] = None,
    battle_mode: str = "1v1",
    teammate_user_id: str = "",
    teammate_username: str = "",
    teammate_display_name: str = "",
    teammate_avatar_url: str = "",
    opponent2_user_id: str = "",
    opponent2_username: str = "",
    opponent2_display_name: str = "",
    opponent2_avatar_url: str = "",
    opponent3_user_id: str = "",
    opponent3_username: str = "",
    opponent3_display_name: str = "",
    opponent3_avatar_url: str = "",
    streamer_rank: int = 0,
) -> int:
    """
    Registriert den Start eines TikTok Battles (1v1, 2v2, 1v1v1 Dreier oder 1v1v1v1 4er-Einzel) in der Datenbank.
    Gibt die lokale Datenbank-ID (id) des Battle-Eintrags zurück.
    """
    started_at = started_at or datetime.now().isoformat(timespec="seconds")
    created_at = started_at

    with get_db() as conn:
        # Falls battle_id leer oder nur ein Zeitstempel ist: Prüfen, ob der getrackte Gegner bereits ein aktives Battle gestartet hat
        if opponent_username and (not battle_id or len(str(battle_id)) < 8):
            my_row = conn.execute("SELECT username FROM streamers WHERE id = ?", (streamer_id,)).fetchone()
            if my_row:
                my_uname = str(my_row["username"] or "").lower()
                partner_active = conn.execute(
                    """
                    SELECT battle_id FROM tiktok_battles
                    WHERE LOWER(opponent_username) = ? AND status = 'active'
                    ORDER BY id DESC LIMIT 1
                    """,
                    (my_uname,),
                ).fetchone()
                if partner_active and partner_active["battle_id"]:
                    battle_id = partner_active["battle_id"]

        existing = conn.execute(
            """
            SELECT id, battle_mode, opponent_username, teammate_username, opponent2_username, opponent3_username FROM tiktok_battles
            WHERE streamer_id = ? AND battle_id = ? AND status = 'active'
            ORDER BY id DESC LIMIT 1
            """,
            (streamer_id, str(battle_id)),
        ).fetchone()
        if existing:
            # Nachträgliche Aktualisierung falls Partner/Gegner erst jetzt per Event bekannt wurden
            conn.execute(
                """
                UPDATE tiktok_battles
                SET battle_mode = CASE WHEN (battle_mode IS NULL OR battle_mode = '1v1') AND ? != '1v1' THEN ? ELSE battle_mode END,
                    opponent_username = CASE WHEN (opponent_username IS NULL OR opponent_username = '') THEN ? ELSE opponent_username END,
                    opponent_display_name = CASE WHEN (opponent_display_name IS NULL OR opponent_display_name = '') THEN ? ELSE opponent_display_name END,
                    opponent_avatar_url = CASE WHEN (opponent_avatar_url IS NULL OR opponent_avatar_url = '') THEN ? ELSE opponent_avatar_url END,
                    opponent_user_id = CASE WHEN (opponent_user_id IS NULL OR opponent_user_id = '') THEN ? ELSE opponent_user_id END,
                    teammate_username = CASE WHEN (teammate_username IS NULL OR teammate_username = '') THEN ? ELSE teammate_username END,
                    teammate_display_name = CASE WHEN (teammate_display_name IS NULL OR teammate_display_name = '') THEN ? ELSE teammate_display_name END,
                    teammate_avatar_url = CASE WHEN (teammate_avatar_url IS NULL OR teammate_avatar_url = '') THEN ? ELSE teammate_avatar_url END,
                    teammate_user_id = CASE WHEN (teammate_user_id IS NULL OR teammate_user_id = '') THEN ? ELSE teammate_user_id END,
                    opponent2_username = CASE WHEN (opponent2_username IS NULL OR opponent2_username = '') THEN ? ELSE opponent2_username END,
                    opponent2_display_name = CASE WHEN (opponent2_display_name IS NULL OR opponent2_display_name = '') THEN ? ELSE opponent2_display_name END,
                    opponent2_avatar_url = CASE WHEN (opponent2_avatar_url IS NULL OR opponent2_avatar_url = '') THEN ? ELSE opponent2_avatar_url END,
                    opponent2_user_id = CASE WHEN (opponent2_user_id IS NULL OR opponent2_user_id = '') THEN ? ELSE opponent2_user_id END,
                    opponent3_username = CASE WHEN (opponent3_username IS NULL OR opponent3_username = '') THEN ? ELSE opponent3_username END,
                    opponent3_display_name = CASE WHEN (opponent3_display_name IS NULL OR opponent3_display_name = '') THEN ? ELSE opponent3_display_name END,
                    opponent3_avatar_url = CASE WHEN (opponent3_avatar_url IS NULL OR opponent3_avatar_url = '') THEN ? ELSE opponent3_avatar_url END,
                    opponent3_user_id = CASE WHEN (opponent3_user_id IS NULL OR opponent3_user_id = '') THEN ? ELSE opponent3_user_id END,
                    streamer_rank = CASE WHEN (streamer_rank IS NULL OR streamer_rank = 0) AND ? > 0 THEN ? ELSE streamer_rank END
                WHERE id = ?
                """,
                (
                    battle_mode, battle_mode,
                    str(opponent_username or ""), str(opponent_display_name or opponent_username or ""),
                    str(opponent_avatar_url or ""), str(opponent_user_id or ""),
                    str(teammate_username or ""), str(teammate_display_name or teammate_username or ""),
                    str(teammate_avatar_url or ""), str(teammate_user_id or ""),
                    str(opponent2_username or ""), str(opponent2_display_name or opponent2_username or ""),
                    str(opponent2_avatar_url or ""), str(opponent2_user_id or ""),
                    str(opponent3_username or ""), str(opponent3_display_name or opponent3_username or ""),
                    str(opponent3_avatar_url or ""), str(opponent3_user_id or ""),
                    int(streamer_rank or 0), int(streamer_rank or 0),
                    int(existing["id"]),
                ),
            )
            return int(existing["id"])

        cursor = conn.execute(
            """
            INSERT INTO tiktok_battles (
                streamer_id, session_id, battle_id, opponent_user_id,
                opponent_username, opponent_display_name, opponent_avatar_url,
                started_at, duration_seconds, streamer_score, opponent_score,
                result, status, created_at,
                battle_mode, teammate_user_id, teammate_username, teammate_display_name,
                teammate_avatar_url, teammate_score, opponent2_user_id, opponent2_username,
                opponent2_display_name, opponent2_avatar_url, opponent2_score,
                opponent3_user_id, opponent3_username, opponent3_display_name,
                opponent3_avatar_url, opponent3_score, streamer_rank
            ) VALUES (
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, 0, 0,
                'ONGOING', 'active', ?,
                ?, ?, ?, ?,
                ?, 0, ?, ?,
                ?, ?, 0,
                ?, ?, ?,
                ?, 0, ?
            )
            """,
            (
                streamer_id,
                session_id,
                str(battle_id),
                str(opponent_user_id or ""),
                str(opponent_username or ""),
                str(opponent_display_name or opponent_username or ""),
                str(opponent_avatar_url or ""),
                started_at,
                int(duration_seconds or 300),
                created_at,
                str(battle_mode or "1v1"),
                str(teammate_user_id or ""),
                str(teammate_username or ""),
                str(teammate_display_name or teammate_username or ""),
                str(teammate_avatar_url or ""),
                str(opponent2_user_id or ""),
                str(opponent2_username or ""),
                str(opponent2_display_name or opponent2_username or ""),
                str(opponent2_avatar_url or ""),
                str(opponent3_user_id or ""),
                str(opponent3_username or ""),
                str(opponent3_display_name or opponent3_username or ""),
                str(opponent3_avatar_url or ""),
                int(streamer_rank or 0),
            ),
        )
        return int(cursor.lastrowid)


def update_battle_scores(
    battle_db_id: int,
    streamer_score: int,
    opponent_score: int,
    streamer_mvp_name: Optional[str] = None,
    streamer_mvp_score: Optional[int] = None,
    streamer_mvp_avatar: Optional[str] = None,
    opponent_mvp_name: Optional[str] = None,
    opponent_mvp_score: Optional[int] = None,
    opponent_mvp_avatar: Optional[str] = None,
    teammate_score: Optional[int] = None,
    opponent2_score: Optional[int] = None,
    opponent3_score: Optional[int] = None,
    streamer_rank: Optional[int] = None,
    battle_mode: Optional[str] = None,
    raw_data_json: Optional[str] = None,
) -> None:
    """
    Aktualisiert fortlaufende Zwischenstände und MVP-Spender während eines aktiven Battles (1v1, 2v2, 1v1v1 oder 1v1v1v1).
    """
    with get_db() as conn:
        conn.execute(
            """
            UPDATE tiktok_battles
            SET streamer_score = ?,
                opponent_score = ?,
                teammate_score = COALESCE(?, teammate_score),
                opponent2_score = COALESCE(?, opponent2_score),
                opponent3_score = COALESCE(?, opponent3_score),
                streamer_rank = COALESCE(?, streamer_rank),
                battle_mode = COALESCE(?, battle_mode),
                streamer_mvp_name = COALESCE(?, streamer_mvp_name),
                streamer_mvp_score = COALESCE(?, streamer_mvp_score),
                streamer_mvp_avatar = COALESCE(?, streamer_mvp_avatar),
                opponent_mvp_name = COALESCE(?, opponent_mvp_name),
                opponent_mvp_score = COALESCE(?, opponent_mvp_score),
                opponent_mvp_avatar = COALESCE(?, opponent_mvp_avatar),
                raw_data_json = COALESCE(?, raw_data_json)
            WHERE id = ?
            """,
            (
                int(streamer_score),
                int(opponent_score),
                teammate_score,
                opponent2_score,
                opponent3_score,
                streamer_rank,
                battle_mode,
                streamer_mvp_name,
                streamer_mvp_score,
                streamer_mvp_avatar,
                opponent_mvp_name,
                opponent_mvp_score,
                opponent_mvp_avatar,
                raw_data_json,
                battle_db_id,
            ),
        )


def record_battle_finish(
    battle_db_id: int,
    streamer_score: int,
    opponent_score: int,
    result: Optional[str] = None,
    streamer_mvp_name: str = "",
    streamer_mvp_score: int = 0,
    streamer_mvp_avatar: str = "",
    opponent_mvp_name: str = "",
    opponent_mvp_score: int = 0,
    opponent_mvp_avatar: str = "",
    teammate_score: Optional[int] = None,
    opponent2_score: Optional[int] = None,
    opponent3_score: Optional[int] = None,
    streamer_rank: Optional[int] = None,
    battle_mode: Optional[str] = None,
    raw_data_json: Optional[str] = None,
    ended_at: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Schließt ein Battle ab (1v1, 2v2, 1v1v1 oder 1v1v1v1), ermittelt Sieger/Verlierer/Platzierung,
    aggregiert während des Duells generierte Geschenke/Coins/EUR und speichert den Endstand.
    """
    ended_at = ended_at or datetime.now().isoformat(timespec="seconds")
    cfg = get_settings()

    # Platzierungs- und Ergebnisermittlung für Free-for-all Modi (1v1v1 und 1v1v1v1)
    if battle_mode in ("1v1v1", "1v1v1v1"):
        scores = [("streamer", streamer_score), ("opp1", opponent_score), ("opp2", opponent2_score or 0)]
        if battle_mode == "1v1v1v1":
            scores.append(("opp3", opponent3_score or 0))
        scores_sorted = sorted(scores, key=lambda x: x[1], reverse=True)
        computed_rank = 1
        for idx, (who, _) in enumerate(scores_sorted):
            if who == "streamer":
                computed_rank = idx + 1
                break
        streamer_rank = streamer_rank or computed_rank

        if not result or result == "ONGOING":
            if streamer_rank == 1:
                # Prüfen auf Gleichstand mit Platz 2
                if len(scores_sorted) > 1 and scores_sorted[0][1] == scores_sorted[1][1] and scores_sorted[0][1] > 0:
                    result = "DRAW"
                else:
                    result = "WIN"
            else:
                result = "LOSE"
    elif not result or result == "ONGOING":
        if streamer_score > opponent_score:
            result = "WIN"
        elif streamer_score < opponent_score:
            result = "LOSE"
        else:
            result = "DRAW"

    with get_db() as conn:
        b_row = conn.execute(
            "SELECT * FROM tiktok_battles WHERE id = ?", (battle_db_id,)
        ).fetchone()
        if not b_row:
            return {}

        streamer_id = b_row["streamer_id"]
        started_at = b_row["started_at"]

        # Gifts während des Duell-Fensters aufsummieren
        gift_agg = conn.execute(
            """
            SELECT COALESCE(SUM(total_coins), 0) AS coins
            FROM gift_events
            WHERE streamer_id = ? AND created_at >= ? AND created_at <= ?
            """,
            (streamer_id, started_at, ended_at),
        ).fetchone()

        coins_earned = int(gift_agg["coins"] or 0) if gift_agg else 0
        usd_net = round(coins_earned * cfg["usd_per_diamond"], 2)
        eur_net = round(usd_net * cfg["usd_to_eur_rate"], 2)
        usd_gross = round(coins_earned * cfg["gross_usd_per_coin"], 2)
        eur_gross = round(usd_gross * cfg["usd_to_eur_rate"], 2)

        duration_sec = b_row["duration_seconds"] or 300
        try:
            s_dt = datetime.fromisoformat(started_at)
            e_dt = datetime.fromisoformat(ended_at)
            duration_sec = max(1, int(round((e_dt - s_dt).total_seconds())))
        except Exception:
            pass

        conn.execute(
            """
            UPDATE tiktok_battles
            SET streamer_score = ?,
                opponent_score = ?,
                teammate_score = COALESCE(?, teammate_score),
                opponent2_score = COALESCE(?, opponent2_score),
                opponent3_score = COALESCE(?, opponent3_score),
                streamer_rank = COALESCE(?, streamer_rank),
                battle_mode = COALESCE(?, battle_mode),
                result = ?,
                streamer_mvp_name = ?,
                streamer_mvp_score = ?,
                streamer_mvp_avatar = ?,
                opponent_mvp_name = ?,
                opponent_mvp_score = ?,
                opponent_mvp_avatar = ?,
                coins_earned = ?,
                usd_net = ?,
                eur_net = ?,
                usd_gross = ?,
                eur_gross = ?,
                duration_seconds = ?,
                ended_at = ?,
                status = 'finished',
                raw_data_json = COALESCE(?, raw_data_json)
            WHERE id = ?
            """,
            (
                int(streamer_score),
                int(opponent_score),
                teammate_score,
                opponent2_score,
                opponent3_score,
                streamer_rank,
                battle_mode,
                result,
                streamer_mvp_name or b_row["streamer_mvp_name"] or "",
                int(streamer_mvp_score or b_row["streamer_mvp_score"] or 0),
                streamer_mvp_avatar or b_row["streamer_mvp_avatar"] or "",
                opponent_mvp_name or b_row["opponent_mvp_name"] or "",
                int(opponent_mvp_score or b_row["opponent_mvp_score"] or 0),
                opponent_mvp_avatar or b_row["opponent_mvp_avatar"] or "",
                coins_earned,
                usd_net,
                eur_net,
                usd_gross,
                eur_gross,
                duration_sec,
                ended_at,
                raw_data_json,
                battle_db_id,
            ),
        )

        updated_row = conn.execute(
            "SELECT * FROM tiktok_battles WHERE id = ?", (battle_db_id,)
        ).fetchone()
        return dict(updated_row) if updated_row else {}


def get_battles_list(
    streamer_id: Optional[int] = None,
    period: str = "all",
    result_filter: Optional[str] = None,
    mode_filter: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> Dict[str, Any]:
    """
    Liefert paginierte Liste aller erfassten Battles mit Streamer- und Gegnerdetails.
    Unterstützt 1v1, 2v2, 1v1v1 und 1v1v1v1 Matches und gezielte Filterung nach Modus.
    Erkennt interne Duelle zwischen zwei getrackten Streamern und konsolidiert diese ohne Doppelung.
    """
    cutoff = _get_period_cutoff(period)
    where_clauses = []
    params = []

    if streamer_id:
        where_clauses.append("b.streamer_id = ?")
        params.append(streamer_id)
    else:
        # In der Gesamtansicht: Duplikate von internen Duellen herausfiltern (nur kanonische Zeile mit MIN(id))
        where_clauses.append(
            "(b.battle_id = '' OR b.id = (SELECT MIN(b2.id) FROM tiktok_battles b2 WHERE b2.battle_id = b.battle_id))"
        )
    if cutoff:
        where_clauses.append("b.created_at >= ?")
        params.append(cutoff)
    if result_filter and result_filter.upper() != "ALL":
        where_clauses.append("b.result = ?")
        params.append(result_filter.upper())
    if mode_filter and mode_filter.upper() != "ALL":
        where_clauses.append("b.battle_mode = ?")
        params.append(mode_filter.lower())
    if search and search.strip():
        term = f"%{search.strip().lower()}%"
        where_clauses.append(
            "(LOWER(b.opponent_username) LIKE ? OR LOWER(b.opponent_display_name) LIKE ? "
            "OR LOWER(b.teammate_username) LIKE ? OR LOWER(b.teammate_display_name) LIKE ? "
            "OR LOWER(b.opponent2_username) LIKE ? OR LOWER(b.opponent2_display_name) LIKE ? "
            "OR LOWER(b.opponent3_username) LIKE ? OR LOWER(b.opponent3_display_name) LIKE ?)"
        )
        params.extend([term, term, term, term, term, term, term, term])

    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    with get_db() as conn:
        count_row = conn.execute(
            f"SELECT COUNT(b.id) AS cnt FROM tiktok_battles b {where_sql}",
            tuple(params),
        ).fetchone()
        total_count = int(count_row["cnt"] or 0) if count_row else 0

        query_sql = f"""
            SELECT
                b.*,
                s.username AS streamer_username,
                s.display_name AS streamer_display_name,
                s.avatar_url AS streamer_avatar_url
            FROM tiktok_battles b
            JOIN streamers s ON s.id = b.streamer_id
            {where_sql}
            ORDER BY b.started_at DESC, b.id DESC
            LIMIT ? OFFSET ?
        """
        rows = conn.execute(query_sql, tuple(params + [limit, offset])).fetchall()
        raw_battles = [dict(r) for r in rows]

        # Getrackte Streamer zur schnellen Gegnererkennung laden
        all_streamers = conn.execute("SELECT id, username, display_name, avatar_url FROM streamers").fetchall()
        streamer_by_uname = {str(r["username"]).lower(): dict(r) for r in all_streamers}

        battles = []
        for b in raw_battles:
            opp_uname = str(b.get("opponent_username") or "").lower()
            is_opp_tracked = opp_uname in streamer_by_uname
            b_id = str(b.get("battle_id") or "").strip()

            partner_row = None
            if b_id and b_id != "":
                p_res = conn.execute(
                    """
                    SELECT b.*, s.username AS streamer_username, s.display_name AS streamer_display_name, s.avatar_url AS streamer_avatar_url
                    FROM tiktok_battles b
                    JOIN streamers s ON s.id = b.streamer_id
                    WHERE b.battle_id = ? AND b.id != ?
                    LIMIT 1
                    """,
                    (b_id, b["id"]),
                ).fetchone()
                if p_res:
                    partner_row = dict(p_res)

            # Falls keine battle_id passte, aber Gegner getrackt ist: Zeitfenster prüfen (±180s)
            if not partner_row and is_opp_tracked:
                partner_streamer = streamer_by_uname[opp_uname]
                s_at = b.get("started_at") or b.get("created_at") or ""
                if s_at:
                    try:
                        s_dt = datetime.fromisoformat(s_at.replace("Z", ""))
                        win_start = (s_dt - timedelta(seconds=180)).isoformat(timespec="seconds")
                        win_end = (s_dt + timedelta(seconds=180)).isoformat(timespec="seconds")
                        p_res = conn.execute(
                            """
                            SELECT b.*, s.username AS streamer_username, s.display_name AS streamer_display_name, s.avatar_url AS streamer_avatar_url
                            FROM tiktok_battles b
                            JOIN streamers s ON s.id = b.streamer_id
                            WHERE b.streamer_id = ? AND LOWER(b.opponent_username) = ? AND b.id != ?
                              AND b.started_at >= ? AND b.started_at <= ?
                            ORDER BY b.id DESC LIMIT 1
                            """,
                            (partner_streamer["id"], str(b.get("streamer_username") or "").lower(), b["id"], win_start, win_end),
                        ).fetchone()
                        if p_res:
                            partner_row = dict(p_res)
                    except Exception:
                        pass

            if partner_row or is_opp_tracked:
                b["is_internal"] = True
                p = partner_row or {}
                partner_st = streamer_by_uname.get(opp_uname) or {}

                # Seite A und B bestimmen
                if streamer_id:
                    # In der Einzelstreamer-Ansicht bleibt der gewählte Streamer links (Seite A)
                    b["is_single_view"] = True
                    side_a_data = b
                    side_b_data = p
                    side_b_uname = p.get("streamer_username") or partner_st.get("username") or b.get("opponent_username")
                    side_b_dname = p.get("streamer_display_name") or partner_st.get("display_name") or b.get("opponent_display_name")
                    side_b_avatar = p.get("streamer_avatar_url") or partner_st.get("avatar_url") or b.get("opponent_avatar_url")
                    side_b_score = p.get("streamer_score", b.get("opponent_score", 0))
                    side_b_coins = p.get("coins_earned", 0)
                    side_b_eur = float(p.get("eur_net", 0.0))
                    side_b_id = p.get("streamer_id") or partner_st.get("id")
                else:
                    # In der Gesamtansicht: Der Streamer mit dem höheren Score (oder Seite A) kommt nach links
                    b["is_single_view"] = False
                    score_b = p.get("streamer_score", b.get("opponent_score", 0))
                    score_a = b.get("streamer_score", 0)
                    if score_b > score_a:
                        side_a_data = p
                        side_b_data = b
                        side_b_uname = b.get("streamer_username")
                        side_b_dname = b.get("streamer_display_name")
                        side_b_avatar = b.get("streamer_avatar_url")
                        side_b_score = score_a
                        side_b_coins = b.get("coins_earned", 0)
                        side_b_eur = float(b.get("eur_net", 0.0))
                        side_b_id = b.get("streamer_id")
                    else:
                        side_a_data = b
                        side_b_data = p
                        side_b_uname = p.get("streamer_username") or partner_st.get("username") or b.get("opponent_username")
                        side_b_dname = p.get("streamer_display_name") or partner_st.get("display_name") or b.get("opponent_display_name")
                        side_b_avatar = p.get("streamer_avatar_url") or partner_st.get("avatar_url") or b.get("opponent_avatar_url")
                        side_b_score = score_b
                        side_b_coins = p.get("coins_earned", 0)
                        side_b_eur = float(p.get("eur_net", 0.0))
                        side_b_id = p.get("streamer_id") or partner_st.get("id")

                coins_a = side_a_data.get("coins_earned", 0) or 0
                eur_a = float(side_a_data.get("eur_net", 0.0) or 0.0)
                tot_coins = coins_a + side_b_coins
                tot_eur = round(eur_a + side_b_eur, 2)

                b["total_coins"] = tot_coins
                b["total_eur_net"] = tot_eur
                b["coins_earned"] = tot_coins
                b["eur_net"] = tot_eur

                score_a_val = side_a_data.get("streamer_score", 0) or 0
                score_b_val = side_b_score or 0
                if score_a_val > score_b_val:
                    b["winner_username"] = side_a_data.get("streamer_username")
                    b["winner_display_name"] = side_a_data.get("streamer_display_name")
                elif score_b_val > score_a_val:
                    b["winner_username"] = side_b_uname
                    b["winner_display_name"] = side_b_dname
                else:
                    b["winner_username"] = None
                    b["winner_display_name"] = None

                b["streamer_a"] = {
                    "id": side_a_data.get("streamer_id"),
                    "username": side_a_data.get("streamer_username"),
                    "display_name": side_a_data.get("streamer_display_name"),
                    "avatar_url": side_a_data.get("streamer_avatar_url") or "/static/avatar_default.png",
                    "score": score_a_val,
                    "coins_earned": coins_a,
                    "eur_net": eur_a,
                    "mvp_name": side_a_data.get("streamer_mvp_name") or "",
                    "mvp_score": side_a_data.get("streamer_mvp_score") or 0,
                    "mvp_avatar": side_a_data.get("streamer_mvp_avatar") or "",
                    "result": side_a_data.get("result") or ("WIN" if score_a_val > score_b_val else ("LOSE" if score_a_val < score_b_val else "DRAW")),
                }

                b["streamer_b"] = {
                    "id": side_b_id,
                    "username": side_b_uname,
                    "display_name": side_b_dname,
                    "avatar_url": side_b_avatar or "/static/avatar_default.png",
                    "score": score_b_val,
                    "coins_earned": side_b_coins,
                    "eur_net": side_b_eur,
                    "mvp_name": side_b_data.get("streamer_mvp_name") or b.get("opponent_mvp_name") or "",
                    "mvp_score": side_b_data.get("streamer_mvp_score") or b.get("opponent_mvp_score") or 0,
                    "mvp_avatar": side_b_data.get("streamer_mvp_avatar") or b.get("opponent_mvp_avatar") or "",
                    "result": side_b_data.get("result") or ("WIN" if score_b_val > score_a_val else ("LOSE" if score_b_val < score_a_val else "DRAW")),
                }

                # Kompatibilitätsfelder
                b["streamer_username"] = b["streamer_a"]["username"]
                b["streamer_display_name"] = b["streamer_a"]["display_name"]
                b["streamer_avatar_url"] = b["streamer_a"]["avatar_url"]
                b["streamer_score"] = b["streamer_a"]["score"]

                b["opponent_username"] = b["streamer_b"]["username"]
                b["opponent_display_name"] = b["streamer_b"]["display_name"]
                b["opponent_avatar_url"] = b["streamer_b"]["avatar_url"]
                b["opponent_score"] = b["streamer_b"]["score"]
            else:
                b["is_internal"] = False

            battles.append(b)

    return {
        "total": total_count,
        "limit": limit,
        "offset": offset,
        "battles": battles,
    }


def get_battle_stats(
    streamer_id: Optional[int] = None,
    period: str = "all",
) -> Dict[str, Any]:
    """
    Liefert aggregierte Duell-Kennzahlen (Winrate, Duelle gesamt, Einnahmen, Top-Rivale).
    """
    cutoff = _get_period_cutoff(period)

    where_clauses = []
    params = []
    if streamer_id:
        where_clauses.append("streamer_id = ?")
        params.append(streamer_id)
    if cutoff:
        where_clauses.append("created_at >= ?")
        params.append(cutoff)

    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    total_expr = "COUNT(DISTINCT CASE WHEN battle_id != '' THEN battle_id ELSE id END)" if not streamer_id else "COUNT(id)"
    with get_db() as conn:
        agg = conn.execute(
            f"""
            SELECT
                {total_expr} AS total_battles,
                COALESCE(SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END), 0) AS wins,
                COALESCE(SUM(CASE WHEN result = 'LOSE' THEN 1 ELSE 0 END), 0) AS losses,
                COALESCE(SUM(CASE WHEN result = 'DRAW' THEN 1 ELSE 0 END), 0) AS draws,
                COALESCE(SUM(CASE WHEN status = 'active' OR result = 'ONGOING' THEN 1 ELSE 0 END), 0) AS ongoing,
                COALESCE(SUM(coins_earned), 0) AS total_coins,
                COALESCE(SUM(eur_net), 0.0) AS total_eur_net,
                COALESCE(MAX(streamer_score), 0) AS max_streamer_score
            FROM tiktok_battles
            {where_sql}
            """,
            tuple(params),
        ).fetchone()

        total = int(agg["total_battles"] or 0)
        wins = int(agg["wins"] or 0)
        losses = int(agg["losses"] or 0)
        draws = int(agg["draws"] or 0)
        ongoing = int(agg["ongoing"] or 0)
        finished = wins + losses + draws
        winrate = round((wins / finished * 100), 1) if finished > 0 else 0.0

        # Top Rivals (Häufige Gegner & Head-to-Head)
        rival_where = ("WHERE " + " AND ".join(where_clauses + ["opponent_username != ''"])) if where_clauses else "WHERE opponent_username != ''"
        rival_rows = conn.execute(
            f"""
            SELECT
                opponent_username,
                MAX(opponent_display_name) AS opponent_display_name,
                MAX(opponent_avatar_url) AS opponent_avatar_url,
                COUNT(id) AS matches_count,
                COALESCE(SUM(CASE WHEN result = 'WIN' THEN 1 ELSE 0 END), 0) AS wins,
                COALESCE(SUM(CASE WHEN result = 'LOSE' THEN 1 ELSE 0 END), 0) AS losses,
                COALESCE(SUM(CASE WHEN result = 'DRAW' THEN 1 ELSE 0 END), 0) AS draws,
                COALESCE(SUM(coins_earned), 0) AS total_coins,
                COALESCE(SUM(eur_net), 0.0) AS total_eur_net,
                AVG(streamer_score) AS avg_streamer_score,
                AVG(opponent_score) AS avg_opponent_score
            FROM tiktok_battles
            {rival_where}
            GROUP BY opponent_username
            ORDER BY matches_count DESC, total_coins DESC
            LIMIT 10
            """,
            tuple(params),
        ).fetchall()

        rivals = []
        for r in rival_rows:
            m_cnt = int(r["matches_count"] or 0)
            w_cnt = int(r["wins"] or 0)
            r_fin = w_cnt + int(r["losses"] or 0) + int(r["draws"] or 0)
            r_winrate = round((w_cnt / r_fin * 100), 1) if r_fin > 0 else 0.0
            rivals.append({
                "opponent_username": r["opponent_username"],
                "opponent_display_name": r["opponent_display_name"] or r["opponent_username"],
                "opponent_avatar_url": r["opponent_avatar_url"] or "",
                "matches_count": m_cnt,
                "wins": w_cnt,
                "losses": int(r["losses"] or 0),
                "draws": int(r["draws"] or 0),
                "winrate_pct": r_winrate,
                "total_coins": int(r["total_coins"] or 0),
                "total_eur_net": round(float(r["total_eur_net"] or 0.0), 2),
                "avg_streamer_score": int(round(r["avg_streamer_score"] or 0)),
                "avg_opponent_score": int(round(r["avg_opponent_score"] or 0)),
            })

    return {
        "total_battles": total,
        "wins": wins,
        "losses": losses,
        "draws": draws,
        "ongoing": ongoing,
        "winrate_pct": winrate,
        "total_coins": int(agg["total_coins"] or 0),
        "total_eur_net": round(float(agg["total_eur_net"] or 0.0), 2),
        "max_streamer_score": int(agg["max_streamer_score"] or 0),
        "top_opponent": rivals[0] if rivals else None,
        "rivals": rivals,
    }


def get_battle_details(battle_id: int) -> Optional[Dict[str, Any]]:
    """
    Liefert vollständige Details eines Battles inkl. aller Geschenke, die während des Matches empfangen wurden.
    """
    with get_db() as conn:
        b_row = conn.execute(
            """
            SELECT
                b.*,
                s.username AS streamer_username,
                s.display_name AS streamer_display_name,
                s.avatar_url AS streamer_avatar_url
            FROM tiktok_battles b
            JOIN streamers s ON s.id = b.streamer_id
            WHERE b.id = ?
            """,
            (battle_id,),
        ).fetchone()
        if not b_row:
            return None

        battle = dict(b_row)

        gifts = []
        if battle.get("started_at") and battle.get("ended_at"):
            g_rows = conn.execute(
                """
                SELECT * FROM gift_events
                WHERE streamer_id = ? AND created_at >= ? AND created_at <= ?
                ORDER BY total_coins DESC, id DESC
                LIMIT 50
                """,
                (battle["streamer_id"], battle["started_at"], battle["ended_at"]),
            ).fetchall()
            gifts = [dict(g) for g in g_rows]

        # Partner-Battle prüfen falls internes Derby
        partner_row = None
        b_id = str(battle.get("battle_id") or "").strip()
        if b_id:
            p_res = conn.execute(
                """
                SELECT b.*, s.username AS streamer_username, s.display_name AS streamer_display_name, s.avatar_url AS streamer_avatar_url
                FROM tiktok_battles b
                JOIN streamers s ON s.id = b.streamer_id
                WHERE b.battle_id = ? AND b.id != ? LIMIT 1
                """,
                (b_id, battle["id"]),
            ).fetchone()
            if p_res:
                partner_row = dict(p_res)

        if partner_row:
            battle["is_internal"] = True
            battle["partner_battle"] = partner_row
            battle["total_coins"] = (battle.get("coins_earned") or 0) + (partner_row.get("coins_earned") or 0)
            battle["total_eur_net"] = round(float(battle.get("eur_net") or 0.0) + float(partner_row.get("eur_net") or 0.0), 2)
            if battle.get("started_at") and battle.get("ended_at"):
                g2_rows = conn.execute(
                    """
                    SELECT * FROM gift_events
                    WHERE streamer_id = ? AND created_at >= ? AND created_at <= ?
                    ORDER BY total_coins DESC, id DESC
                    LIMIT 50
                    """,
                    (partner_row["streamer_id"], battle["started_at"], battle["ended_at"]),
                ).fetchall()
                for g in g2_rows:
                    dg = dict(g)
                    dg["recipient_username"] = partner_row["streamer_username"]
                    gifts.append(dg)
                gifts.sort(key=lambda x: -int(x.get("total_coins", 0)))

        battle["gifts"] = gifts
        return battle


def seed_demo_data() -> None:
    demo_streamers = [
        {"username": "montanablack", "display_name": "MontanaBlack", "follower_count": 2950000},
        {"username": "eliasn97", "display_name": "EliasN97", "follower_count": 1850000},
        {"username": "papaplatte", "display_name": "Papaplatte", "follower_count": 1420000},
    ]
    now = datetime.now()
    streamer_ids = {}
    for s in demo_streamers:
        row = upsert_streamer(
            username=s["username"],
            display_name=s["display_name"],
            follower_count=s["follower_count"],
        )
        streamer_ids[s["username"]] = row["id"]

    sample_gifts = [
        ("montanablack", "king_donator99", "KingDonator", "TikTok Universe", 44999, 1, 1),
        ("montanablack", "lukas_hh", "Lukas HH", "Lion", 29999, 1, 2),
        ("montanablack", "max_power", "MaxPower", "Galaxy", 1000, 12, 6),
        ("eliasn97", "fokus_fan1", "FOKUS Ultra", "Lion", 29999, 1, 2),
        ("eliasn97", "berlin_boy", "BerlinBoy", "Sports Car", 7000, 3, 5),
        ("papaplatte", "domo_enjoyer", "DomoEnjoyer", "Falcon", 10999, 2, 12),
    ]
    for idx, (uname, sender, nick, gname, diamonds, repeat, hours_ago) in enumerate(sample_gifts):
        ts = (now - timedelta(hours=hours_ago)).isoformat(timespec="seconds")
        record_gift_event(
            streamer_id=streamer_ids[uname],
            sender_username=sender,
            sender_nickname=nick,
            gift_name=gname,
            diamond_count=diamonds,
            repeat_count=repeat,
            event_uid=f"demo-{uname}-{idx}",
            source="demo",
            created_at=ts,
        )


def clear_demo_data() -> int:
    with get_db() as conn:
        cur = conn.execute("DELETE FROM gift_events WHERE source = 'demo'")
        return cur.rowcount


# =====================================================================
# SQLITE DATENBANK IMPORTER & INSPECTOR (WEBINTERFACE)
# =====================================================================

def inspect_sqlite_database(sqlite_file_path: str) -> Dict[str, Any]:
    """
    Untersucht eine SQLite-Datei und liefert Informationen über Tabellen,
    Zeilenzahlen und Datengröße zurück.
    """
    if not os.path.exists(sqlite_file_path):
        raise FileNotFoundError(f"SQLite-Datei nicht gefunden: {sqlite_file_path}")

    file_size_bytes = os.path.getsize(sqlite_file_path)
    file_size_mb = round(file_size_bytes / (1024 * 1024), 2)

    src = sqlite3.connect(sqlite_file_path)
    src.row_factory = sqlite3.Row
    try:
        cur = src.cursor()
        existing_tables = [
            r[0] for r in cur.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        ]

        table_counts: Dict[str, int] = {}
        for tbl in ["settings", "streamers", "stream_sessions", "gift_events", "telegram_users", "tiktok_battles"]:
            if tbl in existing_tables:
                try:
                    c = cur.execute(f"SELECT COUNT(*) FROM `{tbl}`").fetchone()[0]
                    table_counts[tbl] = int(c)
                except Exception:
                    table_counts[tbl] = 0
            else:
                table_counts[tbl] = 0

        # Ermittle gefundene Streamer
        streamer_names: List[str] = []
        if "streamers" in existing_tables:
            try:
                s_rows = cur.execute("SELECT username FROM streamers ORDER BY username ASC LIMIT 30").fetchall()
                streamer_names = [r["username"] for r in s_rows]
            except Exception:
                pass

        return {
            "file_path": sqlite_file_path,
            "file_size_bytes": file_size_bytes,
            "file_size_mb": file_size_mb,
            "tables": existing_tables,
            "table_counts": table_counts,
            "streamer_samples": streamer_names,
            "total_records": sum(table_counts.values()),
        }
    finally:
        src.close()


def import_from_sqlite_database(
    sqlite_file_path: str,
    import_tables: Optional[List[str]] = None,
    mode: str = "merge",  # "merge" (REPLACE/INSERT IGNORE) oder "clean" (vorher leeren)
) -> Dict[str, Any]:
    """
    Liest Daten aus einer SQLite-Datei aus und schreibt sie in die aktuell aktive
    Ziel-Datenbank (egal ob SQLite oder MySQL / MariaDB).
    """
    if not os.path.exists(sqlite_file_path):
        raise FileNotFoundError(f"SQLite-Datei nicht gefunden: {sqlite_file_path}")

    all_supported = ["settings", "streamers", "stream_sessions", "gift_events", "telegram_users", "tiktok_battles"]
    target_tables = [t for t in (import_tables or all_supported) if t in all_supported]

    src = sqlite3.connect(sqlite_file_path)
    src.row_factory = sqlite3.Row

    imported_stats: Dict[str, int] = {t: 0 for t in target_tables}
    errors: List[str] = []

    try:
        cur_src = src.cursor()

        with get_db() as dst:
            # 1. Falls "clean", bereinige die gewählten Tabellen (in umgekehrter Fremdschlüssel-Reihenfolge)
            if mode == "clean":
                clean_order = ["gift_events", "tiktok_battles", "stream_sessions", "streamers", "telegram_users", "settings"]
                for tbl in clean_order:
                    if tbl in target_tables:
                        try:
                            dst.execute(f"DELETE FROM `{tbl}`")
                        except Exception as e:
                            errors.append(f"Fehler beim Leeren von `{tbl}`: {e}")

            # 2. SETTINGS
            if "settings" in target_tables:
                try:
                    s_rows = cur_src.execute("SELECT `key`, `value` FROM settings").fetchall()
                    for r in s_rows:
                        dst.execute(
                            "INSERT OR REPLACE INTO settings (`key`, `value`) VALUES (?, ?)",
                            (r["key"], r["value"]),
                        )
                    imported_stats["settings"] = len(s_rows)
                except Exception as e:
                    errors.append(f"Settings Import: {e}")

            # 3. STREAMERS
            if "streamers" in target_tables:
                try:
                    streamer_rows = cur_src.execute("SELECT * FROM streamers ORDER BY id ASC").fetchall()
                    for r in streamer_rows:
                        d = dict(r)
                        dst.execute(
                            """
                            INSERT OR REPLACE INTO streamers (
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
                    imported_stats["streamers"] = len(streamer_rows)
                except Exception as e:
                    errors.append(f"Streamers Import: {e}")

            # 4. STREAM SESSIONS
            if "stream_sessions" in target_tables:
                try:
                    session_rows = cur_src.execute("SELECT * FROM stream_sessions ORDER BY id ASC").fetchall()
                    for r in session_rows:
                        d = dict(r)
                        dst.execute(
                            """
                            INSERT OR REPLACE INTO stream_sessions (
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
                    imported_stats["stream_sessions"] = len(session_rows)
                except Exception as e:
                    errors.append(f"Sessions Import: {e}")

            # 5. GIFT EVENTS
            if "gift_events" in target_tables:
                try:
                    gift_rows = cur_src.execute("SELECT * FROM gift_events ORDER BY id ASC").fetchall()
                    for r in gift_rows:
                        d = dict(r)
                        dst.execute(
                            """
                            INSERT OR IGNORE INTO gift_events (
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
                    imported_stats["gift_events"] = len(gift_rows)
                except Exception as e:
                    errors.append(f"Gifts Import: {e}")

            # 6. TELEGRAM USERS
            if "telegram_users" in target_tables:
                try:
                    tg_rows = cur_src.execute("SELECT * FROM telegram_users ORDER BY id ASC").fetchall()
                    for r in tg_rows:
                        d = dict(r)
                        dst.execute(
                            """
                            INSERT OR REPLACE INTO telegram_users (
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
                    imported_stats["telegram_users"] = len(tg_rows)
                except Exception as e:
                    errors.append(f"Telegram Users Import: {e}")

            # 7. TIKTOK BATTLES
            if "tiktok_battles" in target_tables:
                try:
                    has_battles_table = cur_src.execute(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tiktok_battles'"
                    ).fetchone()[0] > 0
                    if has_battles_table:
                        battle_rows = cur_src.execute("SELECT * FROM tiktok_battles ORDER BY id ASC").fetchall()
                        for r in battle_rows:
                            d = dict(r)
                            dst.execute(
                                """
                                INSERT OR REPLACE INTO tiktok_battles (
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
                        imported_stats["tiktok_battles"] = len(battle_rows)
                except Exception as e:
                    errors.append(f"Battles Import: {e}")

        return {
            "ok": len(errors) == 0,
            "mode": mode,
            "source_file": sqlite_file_path,
            "imported_counts": imported_stats,
            "total_imported": sum(imported_stats.values()),
            "errors": errors,
        }
    finally:
        src.close()


# =====================================================================
# WEBSITE TRAFFIC & BOT SESSIONS ANALYTICS
# =====================================================================

def record_page_view(
    path: str,
    visitor_hash: str,
    user_agent: str = "",
    device_type: str = "desktop",
    referrer: str = "",
    status_code: int = 200,
    response_time_ms: float = 0.0,
) -> None:
    """
    Speichert einen echten Seitenaufruf für die Web-Traffic-Analyse.
    Arbeitet extrem schnell (< 1ms) und blockiert keine Requests.
    """
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO page_views (
                path, visitor_hash, user_agent, device_type, referrer, status_code, response_time_ms, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                path[:250],
                visitor_hash[:64],
                user_agent[:500],
                device_type[:30],
                referrer[:500],
                int(status_code),
                round(float(response_time_ms), 2),
                now_str,
            ),
        )


def record_bot_session(
    session_type: str,
    telegram_id: Optional[int] = None,
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    client_ip_hash: str = "",
    status: str = "active",
    details_json: Optional[str] = None,
) -> None:
    """
    Protokolliert Interaktionen und Sessions mit dem Telegram-Bot und der Mini-App.
    Aktualisiert bestehende offene Sessions oder legt neue an.
    """
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_db() as conn:
        if telegram_id:
            row = conn.execute(
                """
                SELECT id FROM bot_sessions
                WHERE session_type = ? AND telegram_id = ?
                ORDER BY id DESC LIMIT 1
                """,
                (session_type, telegram_id),
            ).fetchone()
            if row:
                conn.execute(
                    """
                    UPDATE bot_sessions
                    SET last_active_at = ?,
                        username = COALESCE(?, username),
                        first_name = COALESCE(?, first_name),
                        status = ?,
                        details_json = COALESCE(?, details_json)
                    WHERE id = ?
                    """,
                    (now_str, username, first_name, status, details_json, row["id"]),
                )
                return

        conn.execute(
            """
            INSERT INTO bot_sessions (
                session_type, telegram_id, username, first_name, client_ip_hash, status, details_json, created_at, last_active_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_type[:30],
                telegram_id,
                (username or "")[:190],
                (first_name or "")[:250],
                (client_ip_hash or "")[:64],
                (status or "active")[:30],
                details_json,
                now_str,
                now_str,
            ),
        )


def get_site_analytics_overview(period: str = "today") -> Dict[str, Any]:
    """
    Aggregiert Web-Traffic, Seitenbesucher, Latenz und Bot-Sessions für das Analyse-Dashboard.
    """
    cutoff = _get_period_cutoff(period)
    with get_db() as conn:
        # 1. KPIs
        row_kpi = conn.execute(
            """
            SELECT
                COUNT(*) AS total_views,
                COUNT(DISTINCT visitor_hash) AS unique_visitors,
                COALESCE(AVG(response_time_ms), 0.0) AS avg_latency,
                SUM(CASE WHEN device_type = 'mobile' THEN 1 ELSE 0 END) AS mobile_views,
                SUM(CASE WHEN device_type = 'desktop' THEN 1 ELSE 0 END) AS desktop_views,
                SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_views
            FROM page_views
            WHERE (? IS NULL OR created_at >= ?)
            """,
            (cutoff, cutoff),
        ).fetchone()

        total_views = int(row_kpi["total_views"] or 0) if row_kpi else 0
        unique_visitors = int(row_kpi["unique_visitors"] or 0) if row_kpi else 0
        avg_latency = round(float(row_kpi["avg_latency"] or 0.0), 1) if row_kpi else 0.0
        mobile_views = int(row_kpi["mobile_views"] or 0) if row_kpi else 0
        desktop_views = int(row_kpi["desktop_views"] or 0) if row_kpi else 0
        error_views = int(row_kpi["error_views"] or 0) if row_kpi else 0

        # 2. Timeline
        is_hourly = period in ("24h", "today")
        substr_len = 13 if is_hourly else 10
        timeline_rows = conn.execute(
            f"""
            SELECT
                SUBSTR(created_at, 1, {substr_len}) AS bucket,
                COUNT(*) AS views,
                COUNT(DISTINCT visitor_hash) AS visitors,
                ROUND(AVG(response_time_ms), 1) AS avg_ms
            FROM page_views
            WHERE (? IS NULL OR created_at >= ?)
            GROUP BY SUBSTR(created_at, 1, {substr_len})
            ORDER BY bucket ASC
            """,
            (cutoff, cutoff),
        ).fetchall()

        timeline = []
        for tr in timeline_rows:
            b = tr["bucket"]
            v = int(tr["views"] or 0)
            vis = int(tr["visitors"] or 0)
            ms = float(tr["avg_ms"] or 0.0)

            if is_hourly:
                parts = b.replace("T", " ").split(" ")
                time_part = f"{parts[1]}:00" if len(parts) > 1 else b
                label = time_part if period == "today" else f"{parts[0][5:]} {time_part}"
            else:
                label = f"{b[8:10]}.{b[5:7]}." if len(b) >= 10 else b

            timeline.append({
                "bucket": b,
                "label": label,
                "views": v,
                "visitors": vis,
                "avg_ms": ms,
            })

        # 3. Top Paths
        paths_rows = conn.execute(
            """
            SELECT
                path,
                COUNT(*) AS views,
                COUNT(DISTINCT visitor_hash) AS visitors,
                ROUND(AVG(response_time_ms), 1) AS avg_ms
            FROM page_views
            WHERE (? IS NULL OR created_at >= ?)
            GROUP BY path
            ORDER BY views DESC
            LIMIT 20
            """,
            (cutoff, cutoff),
        ).fetchall()
        paths = [
            {
                "path": r["path"],
                "views": int(r["views"] or 0),
                "visitors": int(r["visitors"] or 0),
                "avg_ms": float(r["avg_ms"] or 0.0),
            }
            for r in paths_rows
        ]

        # 4. Devices
        device_rows = conn.execute(
            """
            SELECT
                device_type,
                COUNT(*) AS count,
                COUNT(DISTINCT visitor_hash) AS visitors
            FROM page_views
            WHERE (? IS NULL OR created_at >= ?)
            GROUP BY device_type
            ORDER BY count DESC
            """,
            (cutoff, cutoff),
        ).fetchall()
        devices = [
            {"device": r["device_type"], "count": int(r["count"] or 0), "visitors": int(r["visitors"] or 0)}
            for r in device_rows
        ]

        # 5. Top Referrers
        referrer_rows = conn.execute(
            """
            SELECT
                referrer,
                COUNT(*) AS count
            FROM page_views
            WHERE (? IS NULL OR created_at >= ?)
              AND referrer != ''
            GROUP BY referrer
            ORDER BY count DESC
            LIMIT 15
            """,
            (cutoff, cutoff),
        ).fetchall()
        referrers = [{"referrer": r["referrer"], "count": int(r["count"] or 0)} for r in referrer_rows]

        # 6. Recent Views (latest 50)
        recent_rows = conn.execute(
            """
            SELECT id, path, visitor_hash, device_type, referrer, status_code, response_time_ms, created_at
            FROM page_views
            ORDER BY id DESC
            LIMIT 50
            """
        ).fetchall()
        recent_views = [
            {
                "id": r["id"],
                "path": r["path"],
                "visitor_hash": r["visitor_hash"],
                "device_type": r["device_type"],
                "referrer": r["referrer"] or "-",
                "status_code": int(r["status_code"] or 200),
                "response_time_ms": float(r["response_time_ms"] or 0.0),
                "created_at": r["created_at"],
            }
            for r in recent_rows
        ]

        # 7. Bot Sessions (recent 50)
        bot_session_rows = conn.execute(
            """
            SELECT * FROM bot_sessions
            ORDER BY id DESC
            LIMIT 50
            """
        ).fetchall()
        bot_sessions = [dict(r) for r in bot_session_rows]

        # 8. Telegram Users Overview
        tg_users = list_telegram_users()

        return {
            "period": period,
            "kpis": {
                "total_views": total_views,
                "unique_visitors": unique_visitors,
                "avg_latency": avg_latency,
                "mobile_views": mobile_views,
                "desktop_views": desktop_views,
                "error_views": error_views,
            },
            "timeline": timeline,
            "paths": paths,
            "devices": devices,
            "referrers": referrers,
            "recent_views": recent_views,
            "bot_sessions": bot_sessions,
            "telegram_users": tg_users,
        }


# ==============================================================================
# SPENDERRADAR & CHATLOG SYSTEM
# ==============================================================================

WHALE_TIER_WHALE = "whale"       # >= 10,000 Coins / Diamonds (~50 € Netto)
WHALE_TIER_SHARK = "shark"       # >= 2,500 Coins / Diamonds (~12.50 € Netto)
WHALE_TIER_DOLPHIN = "dolphin"   # >= 500 Coins / Diamonds (~2.50 € Netto)


def get_donor_tier(coins: int) -> str:
    """
    Klassifiziert einen Spender anhand der gespendeten Gesamtmünzen.
    - Whale (Wal): >= 10.000 Coins
    - Shark (Hai): >= 2.500 Coins
    - Dolphin (Delfin): >= 500 Coins
    """
    if coins >= 10000:
        return WHALE_TIER_WHALE
    elif coins >= 2500:
        return WHALE_TIER_SHARK
    elif coins >= 500:
        return WHALE_TIER_DOLPHIN
    return ""


def get_known_donor_tiers() -> Dict[str, str]:
    """
    Gibt ein schnelles Mapping {username_lower: tier} aller Spender zurück, die
    mindestens 500 Münzen (Dolphin, Shark oder Whale) gespendet haben.
    Wird vom StreamerWorker als In-Memory-Cache genutzt, um eingehende Chatnachrichten
    ohne Datenbankverzögerung sofort mit dem Spender-Tier zu kennzeichnen.
    """
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT LOWER(sender_username) AS uname, SUM(total_coins) AS coins
            FROM gift_events
            GROUP BY LOWER(sender_username)
            HAVING coins >= 500
            """
        ).fetchall()
        result: Dict[str, str] = {}
        for r in rows:
            u = str(r["uname"]).strip().lower()
            c = int(r["coins"] or 0)
            t = get_donor_tier(c)
            if t:
                result[u] = t
        return result


def batch_record_chat_messages(messages: List[Dict[str, Any]]) -> int:
    """
    Fügt einen Batch von Chatnachrichten mit einer einzigen Query performant ein.
    Wird vom StreamerWorker periodisch (alle 2s) aufgerufen.
    """
    if not messages:
        return 0

    now_default = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rows = []
    for m in messages:
        u_name = str(m.get("username") or "viewer").strip().lstrip("@")
        nick = str(m.get("nickname") or u_name).strip()
        c_text = str(m.get("comment") or "").strip()
        if not c_text:
            continue
        tier = str(m.get("whale_tier") or "")
        is_w = 1 if (m.get("is_whale") or tier) else 0
        rows.append((
            int(m["streamer_id"]),
            m.get("session_id"),
            str(m.get("user_id") or ""),
            u_name,
            nick,
            str(m.get("avatar_url") or ""),
            c_text,
            is_w,
            tier,
            m.get("created_at") or now_default,
        ))

    if not rows:
        return 0

    sql = """
    INSERT INTO chat_messages (
        streamer_id, session_id, user_id, username, nickname,
        avatar_url, comment, is_whale, whale_tier, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    with get_db() as conn:
        conn.executemany(sql, rows)
    return len(rows)


def cleanup_old_chat_messages(days: int = 7) -> int:
    """
    Rolling Retention: Löscht Chat-Nachrichten, die älter als `days` Tage sind (Standard: 7 Tage).
    Die aggregierten Spenderprofile und Geschenk-Events (gift_events) bleiben dauerhaft erhalten!
    """
    cutoff_dt = datetime.now() - timedelta(days=days)
    cutoff_iso = cutoff_dt.isoformat(timespec="seconds")
    cutoff_space = cutoff_dt.strftime("%Y-%m-%d %H:%M:%S")
    with get_db() as conn:
        cur = conn.execute(
            "DELETE FROM chat_messages WHERE created_at < ? OR created_at < ?",
            (cutoff_iso, cutoff_space),
        )
        return getattr(cur, "rowcount", 0) or 0


def get_chat_messages(
    streamer_id: Optional[int] = None,
    limit: int = 100,
    search: Optional[str] = None,
    min_tier: Optional[str] = None,
    only_whales: bool = False,
    before_id: Optional[int] = None,
    after_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """
    Liefert gefilterte Chat-Nachrichten pro Streamer oder global über alle Kanäle.
    Unterstützt Live-Streaming über `after_id` und historische Paginierung via `before_id`.
    """
    where_clauses = ["1=1"]
    params: List[Any] = []

    if streamer_id:
        where_clauses.append("c.streamer_id = ?")
        params.append(streamer_id)

    if search:
        search_pattern = f"%{search.strip()}%"
        where_clauses.append("(c.comment LIKE ? OR c.username LIKE ? OR c.nickname LIKE ?)")
        params.extend([search_pattern, search_pattern, search_pattern])

    if min_tier == "whale":
        where_clauses.append("c.whale_tier = 'whale'")
    elif min_tier == "shark":
        where_clauses.append("c.whale_tier IN ('whale', 'shark')")
    elif min_tier == "dolphin" or only_whales:
        where_clauses.append("(c.is_whale = 1 OR c.whale_tier != '')")

    order_dir = "DESC"
    if after_id:
        where_clauses.append("c.id > ?")
        params.append(after_id)
        order_dir = "ASC"
    elif before_id:
        where_clauses.append("c.id < ?")
        params.append(before_id)
        order_dir = "DESC"

    where_sql = " AND ".join(where_clauses)
    query = f"""
    SELECT 
        c.id, c.streamer_id, c.session_id, c.user_id, c.username, c.nickname,
        c.avatar_url, c.comment, c.is_whale, c.whale_tier, c.created_at,
        s.username AS streamer_username, s.display_name AS streamer_display_name,
        s.avatar_url AS streamer_avatar_url
    FROM chat_messages c
    JOIN streamers s ON s.id = c.streamer_id
    WHERE {where_sql}
    ORDER BY c.id {order_dir}
    LIMIT ?
    """
    params.append(max(1, min(limit, 500)))

    with get_db() as conn:
        rows = conn.execute(query, params).fetchall()
        result = []
        for r in rows:
            rd = dict(r)
            rd["is_whale"] = bool(rd["is_whale"])
            result.append(rd)
        return result


_radar_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_radar_cache_lock = threading.Lock()
_RADAR_CACHE_TTL = 3.0

_loyalty_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_loyalty_cache_lock = threading.Lock()
_LOYALTY_CACHE_TTL = 10.0


def invalidate_radar_cache() -> None:
    with _radar_cache_lock:
        _radar_cache.clear()
    with _loyalty_cache_lock:
        _loyalty_cache.clear()


def get_donor_radar_data(
    period: str = "all",
    min_tier: Optional[str] = None,
    streamer_id: Optional[int] = None,
    cross_streamer_only: bool = False,
    vip_only: bool = False,
    search: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
) -> Dict[str, Any]:
    """
    Aggregiert Spender und Wale über alle getrackten Streamer.
    Liefert KPI-Karten, Cross-Streamer-Erkennung und Top-Spender-Rangliste inkl. VIP/CRM-Status.
    """
    cache_key = f"{period}:{min_tier}:{streamer_id}:{cross_streamer_only}:{vip_only}:{search}:{limit}:{offset}"
    now = time.monotonic()
    with _radar_cache_lock:
        cached = _radar_cache.get(cache_key)
        if cached and (now - cached[0]) < _RADAR_CACHE_TTL:
            return copy.deepcopy(cached[1])

    cutoff = _get_period_cutoff(period)

    where_clauses = ["1=1"]
    params: List[Any] = []

    if cutoff:
        where_clauses.append("g.created_at >= ?")
        params.append(cutoff)

    if streamer_id:
        where_clauses.append("g.streamer_id = ?")
        params.append(streamer_id)

    if search:
        search_pattern = f"%{search.strip().lower()}%"
        where_clauses.append("(LOWER(g.sender_username) LIKE ? OR LOWER(g.sender_nickname) LIKE ?)")
        params.extend([search_pattern, search_pattern])

    where_sql = " AND ".join(where_clauses)

    having_clauses = []
    if min_tier == "whale":
        having_clauses.append("SUM(g.total_coins) >= 10000")
    elif min_tier == "shark":
        having_clauses.append("SUM(g.total_coins) >= 2500")
    elif min_tier == "dolphin":
        having_clauses.append("SUM(g.total_coins) >= 500")

    if cross_streamer_only:
        having_clauses.append("COUNT(DISTINCT g.streamer_id) >= 2")

    if vip_only:
        having_clauses.append("COALESCE(MAX(c.is_vip), 0) = 1")

    having_sql = f"HAVING {' AND '.join(having_clauses)}" if having_clauses else ""

    query = f"""
    SELECT 
        LOWER(g.sender_username) AS uname_key,
        MAX(g.sender_username) AS username,
        MAX(g.sender_nickname) AS display_name,
        SUM(g.total_coins) AS total_coins,
        SUM(g.eur_net) AS total_eur_net,
        SUM(g.usd_net) AS total_usd_net,
        SUM(g.eur_gross) AS total_eur_gross,
        SUM(g.usd_gross) AS total_usd_gross,
        COUNT(g.id) AS total_gifts,
        COUNT(DISTINCT g.streamer_id) AS streamer_count,
        MIN(g.created_at) AS first_seen,
        MAX(g.created_at) AS last_seen,
        COALESCE(MAX(c.is_vip), 0) AS is_vip,
        MAX(c.tags) AS tags,
        MAX(c.notes) AS notes
    FROM gift_events g
    LEFT JOIN donor_crm c ON LOWER(c.username) = LOWER(g.sender_username)
    WHERE {where_sql}
    GROUP BY LOWER(g.sender_username)
    {having_sql}
    ORDER BY total_coins DESC
    LIMIT ? OFFSET ?
    """
    exec_params = list(params) + [max(1, min(limit, 500)), max(0, offset)]

    with get_db() as conn:
        rows = conn.execute(query, exec_params).fetchall()
        donors = []
        for r in rows:
            d = dict(r)
            coins = int(d["total_coins"] or 0)
            d["tier"] = get_donor_tier(coins)
            d["is_cross_streamer"] = int(d["streamer_count"] or 0) >= 2
            d["total_eur_net"] = round(float(d["total_eur_net"] or 0.0), 2)
            d["total_usd_net"] = round(float(d["total_usd_net"] or 0.0), 2)
            d["total_eur_gross"] = round(float(d["total_eur_gross"] or 0.0), 2)
            d["total_usd_gross"] = round(float(d["total_usd_gross"] or 0.0), 2)
            d["is_vip"] = bool(d.get("is_vip"))
            raw_tags = d.get("tags") or ""
            d["tags"] = [t.strip() for t in raw_tags.split(",") if t.strip()]
            d["notes"] = d.get("notes") or ""
            d["has_notes"] = bool(d["notes"].strip())
            donors.append(d)

        # KPIs über alle Spender im Zeitraum
        kpis_query = f"""
        SELECT 
            COUNT(DISTINCT uname) as all_donors,
            SUM(CASE WHEN coins >= 10000 THEN 1 ELSE 0 END) as count_whales,
            SUM(CASE WHEN coins >= 2500 AND coins < 10000 THEN 1 ELSE 0 END) as count_sharks,
            SUM(CASE WHEN coins >= 500 AND coins < 2500 THEN 1 ELSE 0 END) as count_dolphins,
            SUM(CASE WHEN s_count >= 2 AND coins >= 500 THEN 1 ELSE 0 END) as count_cross,
            SUM(CASE WHEN coins >= 500 THEN coins ELSE 0 END) as sum_whale_coins,
            SUM(CASE WHEN coins >= 500 THEN eur_net ELSE 0 END) as sum_whale_eur_net
        FROM (
            SELECT 
                LOWER(g.sender_username) as uname,
                SUM(g.total_coins) as coins,
                SUM(g.eur_net) as eur_net,
                COUNT(DISTINCT g.streamer_id) as s_count
            FROM gift_events g
            WHERE {where_sql}
            GROUP BY LOWER(g.sender_username)
        ) sub
        """
        kpi_row = conn.execute(kpis_query, params).fetchone()

        chat_count_row = conn.execute(
            "SELECT COUNT(*) as total_chat FROM chat_messages"
        ).fetchone()
        total_chat = int(chat_count_row["total_chat"] or 0) if chat_count_row else 0

        vip_cnt_row = conn.execute(
            "SELECT COUNT(*) as total_vips FROM donor_crm WHERE is_vip = 1"
        ).fetchone()
        total_vips = int(vip_cnt_row["total_vips"] or 0) if vip_cnt_row else 0

        w_count = int(kpi_row["count_whales"] or 0) if kpi_row else 0
        s_count = int(kpi_row["count_sharks"] or 0) if kpi_row else 0
        d_count = int(kpi_row["count_dolphins"] or 0) if kpi_row else 0

        kpis = {
            "whales": w_count,
            "sharks": s_count,
            "dolphins": d_count,
            "cross_streamer_whales": int(kpi_row["count_cross"] or 0) if kpi_row else 0,
            "total_tracked_whales": w_count + s_count + d_count,
            "whale_coins": int(kpi_row["sum_whale_coins"] or 0) if kpi_row else 0,
            "whale_eur_net": round(float(kpi_row["sum_whale_eur_net"] or 0.0), 2) if kpi_row else 0.0,
            "total_chat_messages": total_chat,
            "vip_donors": total_vips,
        }

        streamers = conn.execute(
            "SELECT id, username, display_name, avatar_url, is_live FROM streamers ORDER BY display_name ASC"
        ).fetchall()

        result = {
            "period": period,
            "kpis": kpis,
            "donors": donors,
            "streamers": [dict(s) for s in streamers],
        }
        with _radar_cache_lock:
            _radar_cache[cache_key] = (now, result)
        return copy.deepcopy(result)


def get_donor_details(username: str) -> Optional[Dict[str, Any]]:
    """
    Liefert ein umfassendes Spender-Dossier:
    - Gesamtausgaben (Coins, EUR/USD Netto & Brutto, Geschenke-Anzahl)
    - Verteilung über alle beschenkten Streamer
    - Top Lieblingsgeschenke
    - Letzte Chat-Nachrichten über alle Kanäle
    """
    clean_uname = username.strip().lstrip("@").lower()
    with get_db() as conn:
        main_row = conn.execute(
            """
            SELECT 
                MAX(sender_username) as username,
                MAX(sender_nickname) as display_name,
                SUM(total_coins) as total_coins,
                SUM(eur_net) as total_eur_net,
                SUM(usd_net) as total_usd_net,
                SUM(eur_gross) as total_eur_gross,
                SUM(usd_gross) as total_usd_gross,
                COUNT(id) as total_gifts,
                COUNT(DISTINCT streamer_id) as streamer_count,
                MIN(created_at) as first_seen,
                MAX(created_at) as last_seen
            FROM gift_events
            WHERE LOWER(sender_username) = ?
            """,
            (clean_uname,),
        ).fetchone()

        if not main_row or not main_row["total_coins"]:
            chat_user_row = conn.execute(
                "SELECT username, nickname, avatar_url FROM chat_messages WHERE LOWER(username) = ? LIMIT 1",
                (clean_uname,),
            ).fetchone()
            if not chat_user_row:
                return None
            profile = {
                "username": chat_user_row["username"],
                "display_name": chat_user_row["nickname"] or chat_user_row["username"],
                "avatar_url": chat_user_row["avatar_url"],
                "total_coins": 0,
                "total_eur_net": 0.0,
                "total_usd_net": 0.0,
                "total_eur_gross": 0.0,
                "total_usd_gross": 0.0,
                "total_gifts": 0,
                "streamer_count": 0,
                "first_seen": "-",
                "last_seen": "-",
                "tier": "",
                "is_cross_streamer": False,
            }
        else:
            coins = int(main_row["total_coins"] or 0)
            avatar_row = conn.execute(
                "SELECT avatar_url FROM chat_messages WHERE LOWER(username) = ? AND avatar_url != '' ORDER BY id DESC LIMIT 1",
                (clean_uname,),
            ).fetchone()
            avatar_url = avatar_row["avatar_url"] if avatar_row else ""
            profile = {
                "username": main_row["username"],
                "display_name": main_row["display_name"] or main_row["username"],
                "avatar_url": avatar_url,
                "total_coins": coins,
                "total_eur_net": round(float(main_row["total_eur_net"] or 0.0), 2),
                "total_usd_net": round(float(main_row["total_usd_net"] or 0.0), 2),
                "total_eur_gross": round(float(main_row["total_eur_gross"] or 0.0), 2),
                "total_usd_gross": round(float(main_row["total_usd_gross"] or 0.0), 2),
                "total_gifts": int(main_row["total_gifts"] or 0),
                "streamer_count": int(main_row["streamer_count"] or 0),
                "first_seen": main_row["first_seen"],
                "last_seen": main_row["last_seen"],
                "tier": get_donor_tier(coins),
                "is_cross_streamer": int(main_row["streamer_count"] or 0) >= 2,
            }

        # Streamer Breakdown
        streamer_rows = conn.execute(
            """
            SELECT 
                g.streamer_id,
                s.username as streamer_username,
                s.display_name as streamer_display_name,
                s.avatar_url as streamer_avatar_url,
                SUM(g.total_coins) as coins_given,
                SUM(g.eur_net) as eur_net,
                COUNT(g.id) as gift_count,
                MAX(g.created_at) as last_gift_at
            FROM gift_events g
            JOIN streamers s ON s.id = g.streamer_id
            WHERE LOWER(g.sender_username) = ?
            GROUP BY g.streamer_id, s.username, s.display_name, s.avatar_url
            ORDER BY coins_given DESC
            """,
            (clean_uname,),
        ).fetchall()
        streamers_breakdown = []
        for sr in streamer_rows:
            sd = dict(sr)
            sd["eur_net"] = round(float(sd["eur_net"] or 0.0), 2)
            streamers_breakdown.append(sd)

        # Top 6 Lieblingsgeschenke
        gift_rows = conn.execute(
            """
            SELECT 
                gift_name,
                gift_icon_url,
                SUM(repeat_count) as total_sent,
                SUM(total_coins) as total_coins
            FROM gift_events
            WHERE LOWER(sender_username) = ?
            GROUP BY gift_name, gift_icon_url
            ORDER BY total_coins DESC
            LIMIT 6
            """,
            (clean_uname,),
        ).fetchall()
        top_gifts = [dict(gr) for gr in gift_rows]

        # Letzte 25 Chatnachrichten
        chat_rows = conn.execute(
            """
            SELECT 
                c.id, c.streamer_id, c.comment, c.created_at,
                s.username as streamer_username, s.display_name as streamer_display_name
            FROM chat_messages c
            JOIN streamers s ON s.id = c.streamer_id
            WHERE LOWER(c.username) = ?
            ORDER BY c.id DESC
            LIMIT 25
            """,
            (clean_uname,),
        ).fetchall()
        recent_chats = [dict(cr) for cr in chat_rows]

        crm = get_donor_crm(clean_uname)
        profile["is_vip"] = crm["is_vip"]
        profile["tags"] = crm["tags"]
        profile["notes"] = crm["notes"]

        # Loyalitäts-Berechnung (Konzentration auf Hauptstreamer)
        total_spent_coins = sum(int(s.get("coins_given") or 0) for s in streamers_breakdown)
        if total_spent_coins > 0 and streamers_breakdown:
            top_streamer = streamers_breakdown[0]
            top_coins = int(top_streamer.get("coins_given") or 0)
            loyalty_score = round((top_coins / total_spent_coins) * 100, 1)

            if loyalty_score >= 85:
                loyalty_tier = "diehard"
                loyalty_label = "Eingeschworener Stamm-Supporter"
                loyalty_badge = f"💎 {loyalty_score}% Treue"
                loyalty_color = "#38bdf8"
            elif loyalty_score >= 60:
                loyalty_tier = "focused"
                loyalty_label = "Fokussierter Fan"
                loyalty_badge = f"🎯 {loyalty_score}% Fokus"
                loyalty_color = "#34d399"
            elif loyalty_score >= 40:
                loyalty_tier = "multi"
                loyalty_label = "Multi-Streamer Supporter"
                loyalty_badge = f"⚖️ {loyalty_score}% Geteilt"
                loyalty_color = "#fbbf24"
            else:
                loyalty_tier = "hopper"
                loyalty_label = "Wander-Wal / Hopper"
                loyalty_badge = f"🌪️ {loyalty_score}% Sprunghaft"
                loyalty_color = "#f472b6"

            loyalty = {
                "score": loyalty_score,
                "tier": loyalty_tier,
                "label": loyalty_label,
                "badge": loyalty_badge,
                "color": loyalty_color,
                "primary_streamer": top_streamer.get("streamer_username"),
                "primary_streamer_display": top_streamer.get("streamer_display_name") or top_streamer.get("streamer_username"),
                "primary_coins": top_coins,
                "streamer_count": len(streamers_breakdown),
            }
        else:
            loyalty = {
                "score": 0.0,
                "tier": "unknown",
                "label": "Keine Daten",
                "badge": "-",
                "color": "#94a3b8",
                "primary_streamer": "",
                "primary_streamer_display": "",
                "primary_coins": 0,
                "streamer_count": 0,
            }

        # Frontenwechsler-Check (Historisch vs. Letzte 14 Tage)
        cutoff_14d = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
        period_rows = conn.execute(
            """
            SELECT 
                g.streamer_id,
                s.username as streamer_username,
                s.display_name as streamer_display_name,
                CASE WHEN g.created_at < ? THEN 'old' ELSE 'recent' END as period_slot,
                SUM(g.total_coins) as coins
            FROM gift_events g
            JOIN streamers s ON s.id = g.streamer_id
            WHERE LOWER(g.sender_username) = ?
            GROUP BY g.streamer_id, period_slot
            """,
            (cutoff_14d, clean_uname),
        ).fetchall()

        old_streamers: Dict[int, Tuple[str, int]] = {}
        recent_streamers: Dict[int, Tuple[str, int]] = {}
        for pr in period_rows:
            slot = pr["period_slot"]
            s_name = pr["streamer_display_name"] or pr["streamer_username"]
            coins = int(pr["coins"] or 0)
            if slot == "old":
                old_streamers[pr["streamer_id"]] = (s_name, coins)
            else:
                recent_streamers[pr["streamer_id"]] = (s_name, coins)

        frontenwechsel = {
            "is_shifted": False,
            "status_label": "Konstant loyal",
            "description": "Bisher kein Frontenwechsel erkannt.",
            "from_streamer": "",
            "to_streamer": "",
        }

        if old_streamers and recent_streamers:
            top_old_id = max(old_streamers, key=lambda k: old_streamers[k][1])
            top_recent_id = max(recent_streamers, key=lambda k: recent_streamers[k][1])
            if top_old_id != top_recent_id and recent_streamers[top_recent_id][1] >= 200:
                s_from = old_streamers[top_old_id][0]
                s_to = recent_streamers[top_recent_id][0]
                frontenwechsel = {
                    "is_shifted": True,
                    "status_label": "⚠️ Frontenwechsler",
                    "description": f"Früher Hauptunterstützer von {s_from}, schenkt in den letzten 14 Tagen vorrangig an {s_to}!",
                    "from_streamer": s_from,
                    "to_streamer": s_to,
                }
        elif recent_streamers and not old_streamers:
            frontenwechsel["status_label"] = "Neuerscheinung"
            frontenwechsel["description"] = "Erst in den letzten 14 Tagen aktiv geworden."

        return {
            "profile": profile,
            "streamers": streamers_breakdown,
            "top_gifts": top_gifts,
            "recent_chats": recent_chats,
            "crm": crm,
            "loyalty": loyalty,
            "frontenwechsel": frontenwechsel,
        }


def get_donor_crm(username: str) -> Dict[str, Any]:
    """
    Liefert die CRM-Daten (VIP-Status, Tags, interne Notizen) eines Spenders.
    """
    clean_uname = username.strip().lstrip("@").lower()
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT id, username, is_vip, tags, notes, created_at, updated_at
            FROM donor_crm
            WHERE LOWER(username) = ?
            """,
            (clean_uname,),
        ).fetchone()

        if not row:
            return {
                "id": None,
                "username": clean_uname,
                "is_vip": False,
                "tags": [],
                "notes": "",
                "created_at": None,
                "updated_at": None,
            }

        raw_tags = row["tags"] or ""
        tags_list = [t.strip() for t in raw_tags.split(",") if t.strip()]
        return {
            "id": row["id"],
            "username": row["username"],
            "is_vip": bool(row["is_vip"]),
            "tags": tags_list,
            "notes": row["notes"] or "",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }


def save_donor_crm(
    username: str,
    is_vip: Optional[bool] = None,
    tags: Optional[Union[List[str], str]] = None,
    notes: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Speichert oder aktualisiert VIP-Status, Tags und Notizen eines Spenders.
    Vollständig portabel für SQLite und MySQL.
    """
    clean_uname = username.strip().lstrip("@").lower()
    now = datetime.now(timezone.utc).isoformat()

    tags_str: Optional[str] = None
    if tags is not None:
        if isinstance(tags, list):
            tags_str = ",".join([t.strip().replace(",", "") for t in tags if t.strip()])
        else:
            tags_str = str(tags).strip()

    with get_db() as conn:
        existing = conn.execute(
            "SELECT id, is_vip, tags, notes FROM donor_crm WHERE LOWER(username) = ?",
            (clean_uname,),
        ).fetchone()

        if existing:
            new_vip = int(is_vip) if is_vip is not None else int(existing["is_vip"] or 0)
            new_tags = tags_str if tags_str is not None else (existing["tags"] or "")
            new_notes = notes if notes is not None else (existing["notes"] or "")
            conn.execute(
                """
                UPDATE donor_crm
                SET is_vip = ?, tags = ?, notes = ?, updated_at = ?
                WHERE id = ?
                """,
                (new_vip, new_tags, new_notes, now, existing["id"]),
            )
        else:
            new_vip = int(is_vip) if is_vip is not None else 0
            new_tags = tags_str if tags_str is not None else ""
            new_notes = notes if notes is not None else ""
            conn.execute(
                """
                INSERT INTO donor_crm (username, is_vip, tags, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (clean_uname, new_vip, new_tags, new_notes, now, now),
            )

    invalidate_radar_cache()
    return get_donor_crm(clean_uname)


def toggle_donor_vip(username: str) -> Dict[str, Any]:
    """
    Schaltet den VIP-Watchlist-Status eines Spenders um.
    """
    current = get_donor_crm(username)
    return save_donor_crm(username, is_vip=not current["is_vip"])


def get_recent_whale_gifts(
    min_coins: int = 1000,
    after_id: Optional[int] = None,
    limit: int = 20,
) -> List[Dict[str, Any]]:
    """
    Liefert aktuelle Großspenden (Whale- & Shark-Events) für den Live-Ticker und Audio-Alerts.
    """
    query = """
    SELECT 
        g.id, g.streamer_id, g.gift_name, g.gift_icon_url, g.diamond_count,
        g.repeat_count, g.total_coins, g.eur_net, g.usd_net, g.eur_gross, g.usd_gross,
        g.sender_username, g.sender_nickname, g.created_at,
        s.username as streamer_username, s.display_name as streamer_display_name, s.avatar_url as streamer_avatar_url,
        COALESCE(c.is_vip, 0) as is_vip,
        COALESCE(c.tags, '') as tags
    FROM gift_events g
    JOIN streamers s ON s.id = g.streamer_id
    LEFT JOIN donor_crm c ON LOWER(c.username) = LOWER(g.sender_username)
    WHERE g.total_coins >= ?
    """
    params: List[Any] = [min_coins]
    if after_id is not None:
        query += " AND g.id > ? ORDER BY g.id ASC LIMIT ?"
        params.extend([after_id, max(1, min(limit, 100))])
    else:
        query += " ORDER BY g.id DESC LIMIT ?"
        params.append(max(1, min(limit, 100)))

    with get_db() as conn:
        rows = conn.execute(query, params).fetchall()
        alerts = []
        for r in rows:
            d = dict(r)
            coins = int(d["total_coins"] or 0)
            d["is_vip"] = bool(d.get("is_vip"))
            d["tier"] = get_donor_tier(coins)
            d["eur_net"] = round(float(d["eur_net"] or 0.0), 2)
            d["usd_net"] = round(float(d["usd_net"] or 0.0), 2)
            d["eur_gross"] = round(float(d["eur_gross"] or 0.0), 2)
            d["usd_gross"] = round(float(d["usd_gross"] or 0.0), 2)
            raw_tags = d.get("tags") or ""
            d["tags"] = [t.strip() for t in raw_tags.split(",") if t.strip()]
            alerts.append(d)
        return alerts


def get_network_loyalty_and_overlap(
    min_coins: int = 100,
    days_recent: int = 14,
) -> Dict[str, Any]:
    """
    Netzwerkweite Auswertung für den Loyalitäts- & Frontenwechsler-Hub:
    1. Frontenwechsler: Großspender, die ihren primären Streamer gewechselt haben.
    2. Overlap-Matrix: Paare von Streamern, die sich dieselben Großspender teilen.
    """
    cache_key = f"{min_coins}:{days_recent}"
    now = time.monotonic()
    with _loyalty_cache_lock:
        cached = _loyalty_cache.get(cache_key)
        if cached and (now - cached[0]) < _LOYALTY_CACHE_TTL:
            return copy.deepcopy(cached[1])

    with get_db() as conn:
        now_dt = datetime.now(timezone.utc)
        # Zeitspanne der vorhandenen Events prüfen für adaptive Fenster-Teilung
        span_row = conn.execute("SELECT MIN(created_at), MAX(created_at) FROM gift_events").fetchone()
        if span_row and span_row[0] and span_row[1]:
            try:
                min_ts = datetime.fromisoformat(span_row[0].replace("Z", "+00:00"))
                max_ts = datetime.fromisoformat(span_row[1].replace("Z", "+00:00"))
                total_hours = (max_ts - min_ts).total_seconds() / 3600.0
                if total_hours < (days_recent * 24):
                    # Bei kurzer Datenhistorie (< gewählter Zeitraum): Teilung in der Daten-Mitte
                    cutoff_dt = min_ts + (max_ts - min_ts) / 2
                else:
                    cutoff_dt = now_dt - timedelta(days=days_recent / 2)
            except Exception:
                cutoff_dt = now_dt - timedelta(days=days_recent / 2)
        else:
            cutoff_dt = now_dt - timedelta(days=days_recent / 2)

        cutoff = cutoff_dt.isoformat()

        # 1. Frontenwechsler ermitteln
        history_query = """
        SELECT 
            LOWER(g.sender_username) as uname,
            MAX(g.sender_username) as username,
            MAX(g.sender_nickname) as display_name,
            g.streamer_id,
            s.username as streamer_username,
            s.display_name as streamer_display_name,
            s.avatar_url as streamer_avatar_url,
            CASE WHEN g.created_at < ? THEN 'old' ELSE 'recent' END as period_slot,
            SUM(g.total_coins) as coins,
            SUM(g.eur_net) as eur_net,
            COALESCE(MAX(c.is_vip), 0) as is_vip,
            COALESCE(MAX(c.tags), '') as tags
        FROM gift_events g
        JOIN streamers s ON s.id = g.streamer_id
        LEFT JOIN donor_crm c ON LOWER(c.username) = LOWER(g.sender_username)
        GROUP BY LOWER(g.sender_username), g.streamer_id, period_slot
        HAVING SUM(g.total_coins) >= 1
        """
        h_rows = conn.execute(history_query, (cutoff,)).fetchall()

        donors_data: Dict[str, Dict[str, Any]] = {}
        for r in h_rows:
            uname = r["uname"]
            if uname not in donors_data:
                donors_data[uname] = {
                    "username": r["username"],
                    "display_name": r["display_name"] or r["username"],
                    "is_vip": bool(r["is_vip"]),
                    "tags": [t.strip() for t in (r["tags"] or "").split(",") if t.strip()],
                    "old_streamers": {},
                    "recent_streamers": {},
                    "total_coins": 0,
                    "total_eur_net": 0.0,
                }
            coins = int(r["coins"] or 0)
            eur = float(r["eur_net"] or 0.0)
            donors_data[uname]["total_coins"] += coins
            donors_data[uname]["total_eur_net"] += eur
            streamer_info = {
                "id": r["streamer_id"],
                "username": r["streamer_username"],
                "display_name": r["streamer_display_name"] or r["streamer_username"],
                "avatar_url": r["streamer_avatar_url"],
                "coins": coins,
                "eur_net": eur,
            }
            if r["period_slot"] == "old":
                donors_data[uname]["old_streamers"][r["streamer_id"]] = streamer_info
            else:
                donors_data[uname]["recent_streamers"][r["streamer_id"]] = streamer_info

        frontenwechsler = []
        for uname, d in donors_data.items():
            if not d["old_streamers"] or not d["recent_streamers"]:
                continue
            old_top_id = max(d["old_streamers"], key=lambda sid: d["old_streamers"][sid]["coins"])
            recent_top_id = max(d["recent_streamers"], key=lambda sid: d["recent_streamers"][sid]["coins"])

            if old_top_id != recent_top_id:
                old_s = d["old_streamers"][old_top_id]
                recent_s = d["recent_streamers"][recent_top_id]
                old_coins = old_s["coins"]
                recent_coins = recent_s["coins"]

                if (old_coins + recent_coins) >= min_coins:
                    total_recent_coins = sum(s["coins"] for s in d["recent_streamers"].values())
                    recent_share = round((recent_coins / total_recent_coins) * 100, 1) if total_recent_coins > 0 else 0.0
                    shift_ratio = round((recent_coins / (old_coins + recent_coins)), 2) if (old_coins + recent_coins) > 0 else 0.5

                    # Loyalität ermitteln
                    donor_total = d["total_coins"]
                    all_streamer_coins: Dict[int, int] = {}
                    for sid, sinfo in d["old_streamers"].items():
                        all_streamer_coins[sid] = all_streamer_coins.get(sid, 0) + sinfo["coins"]
                    for sid, sinfo in d["recent_streamers"].items():
                        all_streamer_coins[sid] = all_streamer_coins.get(sid, 0) + sinfo["coins"]
                    top_streamer_coins = max(all_streamer_coins.values()) if all_streamer_coins else 0
                    loyalty_ratio = top_streamer_coins / donor_total if donor_total > 0 else 1.0
                    loyalty_score = int(round(loyalty_ratio * 100))

                    if loyalty_score >= 85:
                        classification, label, color = "diehard", "Diehard-Stammspender", "#22c55e"
                    elif loyalty_score >= 65:
                        classification, label, color = "focused", "Fokussierter Spender", "#38bdf8"
                    elif loyalty_score >= 40:
                        classification, label, color = "multi", "Multi-Streamer Spender", "#eab308"
                    else:
                        classification, label, color = "hopper", "Streamer-Hopper", "#ec4899"

                    donor_avatar = None
                    chat_av_row = conn.execute(
                        "SELECT avatar_url FROM chat_messages WHERE LOWER(username) = ? AND avatar_url IS NOT NULL AND avatar_url != '' LIMIT 1",
                        (uname,),
                    ).fetchone()
                    if chat_av_row and chat_av_row[0]:
                        donor_avatar = chat_av_row[0]

                    frontenwechsler.append({
                        "username": d["username"],
                        "display_name": d["display_name"],
                        "avatar_url": donor_avatar,
                        "is_vip": d["is_vip"],
                        "tier": get_donor_tier(d["total_coins"]),
                        "tags": d["tags"],
                        "total_coins": d["total_coins"],
                        "total_net_eur": round(d["total_eur_net"], 2),
                        "loyalty_score": loyalty_score,
                        "classification": classification,
                        "label": label,
                        "color": color,
                        "crm": {
                            "is_vip": d["is_vip"],
                            "tags": d["tags"],
                        },
                        "frontenwechsel": {
                            "shifted": True,
                            "old_streamer": old_s["username"],
                            "old_streamer_display": old_s["display_name"],
                            "old_streamer_avatar": old_s.get("avatar_url") or "",
                            "new_streamer": recent_s["username"],
                            "new_streamer_display": recent_s["display_name"],
                            "new_streamer_avatar": recent_s.get("avatar_url") or "",
                            "old_coins": old_coins,
                            "new_coins": recent_coins,
                            "shift_ratio": shift_ratio,
                        },
                        "from_streamer": {
                            "id": old_s["id"],
                            "username": old_s["username"],
                            "display_name": old_s["display_name"],
                            "avatar_url": old_s.get("avatar_url") or "",
                            "coins": old_coins,
                        },
                        "to_streamer": {
                            "id": recent_s["id"],
                            "username": recent_s["username"],
                            "display_name": recent_s["display_name"],
                            "avatar_url": recent_s.get("avatar_url") or "",
                            "coins": recent_coins,
                            "eur_net": round(recent_s["eur_net"], 2),
                        },
                        "recent_share_percent": recent_share,
                        "shift_volume_coins": recent_coins,
                        "shift_volume_eur": round(recent_s["eur_net"], 2),
                        "migration_type": "Kompletter Wechsel" if old_top_id not in d["recent_streamers"] else "Schwerpunkt-Verlagerung",
                    })

        frontenwechsler.sort(key=lambda x: x["shift_volume_coins"], reverse=True)

        # 2. Streamer Overlap Matrix (Gemeinsame Großspender)
        overlap_query = """
        SELECT 
            d1.streamer_id as s1_id,
            s1.username as s1_username,
            s1.display_name as s1_display_name,
            s1.avatar_url as s1_avatar,
            d2.streamer_id as s2_id,
            s2.username as s2_username,
            s2.display_name as s2_display_name,
            s2.avatar_url as s2_avatar,
            COUNT(d1.uname) as shared_donors_count,
            SUM(d1.coins) as total_coins_a,
            SUM(d2.coins) as total_coins_b,
            SUM(d1.coins + d2.coins) as total_shared_coins,
            SUM(d1.eur_net + d2.eur_net) as shared_volume_eur
        FROM (
            SELECT LOWER(sender_username) as uname, streamer_id, SUM(total_coins) as coins, SUM(eur_net) as eur_net
            FROM gift_events
            GROUP BY LOWER(sender_username), streamer_id
            HAVING SUM(total_coins) >= 1
        ) d1
        JOIN (
            SELECT LOWER(sender_username) as uname, streamer_id, SUM(total_coins) as coins, SUM(eur_net) as eur_net
            FROM gift_events
            GROUP BY LOWER(sender_username), streamer_id
            HAVING SUM(total_coins) >= 1
        ) d2 ON d1.uname = d2.uname AND d1.streamer_id < d2.streamer_id
        JOIN streamers s1 ON s1.id = d1.streamer_id
        JOIN streamers s2 ON s2.id = d2.streamer_id
        GROUP BY d1.streamer_id, d2.streamer_id
        HAVING shared_donors_count >= 1
        ORDER BY total_shared_coins DESC
        LIMIT 25
        """
        pair_rows = conn.execute(overlap_query).fetchall()
        overlap_matrix = []
        for pr in pair_rows:
            p_dict = dict(pr)
            s1_id = p_dict["s1_id"]
            s2_id = p_dict["s2_id"]
            coins_a = int(p_dict.get("total_coins_a") or 0)
            coins_b = int(p_dict.get("total_coins_b") or 0)
            total_coins = int(p_dict.get("total_shared_coins") or (coins_a + coins_b))
            pct_a = round((coins_a / total_coins) * 100, 1) if total_coins > 0 else 50.0
            pct_b = round(100.0 - pct_a, 1)

            # Beide Feldnamens-Standards bedienen
            p_dict["streamer_a_id"] = s1_id
            p_dict["streamer_a_username"] = p_dict["s1_username"]
            p_dict["streamer_a_display_name"] = p_dict["s1_display_name"] or p_dict["s1_username"]
            p_dict["streamer_a_avatar"] = p_dict["s1_avatar"]
            p_dict["streamer_b_id"] = s2_id
            p_dict["streamer_b_username"] = p_dict["s2_username"]
            p_dict["streamer_b_display_name"] = p_dict["s2_display_name"] or p_dict["s2_username"]
            p_dict["streamer_b_avatar"] = p_dict["s2_avatar"]
            p_dict["total_coins_a"] = coins_a
            p_dict["total_coins_b"] = coins_b
            p_dict["total_shared_coins"] = total_coins
            p_dict["shared_volume_coins"] = total_coins
            p_dict["streamer_a_pct"] = pct_a
            p_dict["streamer_b_pct"] = pct_b

            shared_top_rows = conn.execute(
                """
                SELECT 
                    LOWER(g.sender_username) as uname,
                    MAX(g.sender_username) as username,
                    MAX(g.sender_nickname) as display_name,
                    SUM(g.total_coins) as total_coins,
                    COALESCE(MAX(c.is_vip), 0) as is_vip
                FROM gift_events g
                LEFT JOIN donor_crm c ON LOWER(c.username) = LOWER(g.sender_username)
                WHERE g.streamer_id IN (?, ?)
                GROUP BY LOWER(g.sender_username)
                HAVING COUNT(DISTINCT g.streamer_id) = 2
                ORDER BY total_coins DESC
                LIMIT 5
                """,
                (s1_id, s2_id),
            ).fetchall()

            top_shared = []
            for sr in shared_top_rows:
                c_val = int(sr["total_coins"] or 0)
                top_shared.append({
                    "username": sr["username"],
                    "display_name": sr["display_name"] or sr["username"],
                    "total_coins": c_val,
                    "coins": c_val,
                    "is_vip": bool(sr["is_vip"]),
                    "tier": get_donor_tier(c_val),
                })

            p_dict["top_donors"] = top_shared
            p_dict["top_shared_donors"] = top_shared
            p_dict["shared_volume_eur"] = round(float(p_dict.get("shared_volume_eur") or 0.0), 2)
            overlap_matrix.append(p_dict)

        result = {
            "frontenwechsler": frontenwechsler,
            "overlap_matrix": overlap_matrix,
            "days_recent": days_recent,
            "summary": {
                "total_shifters": len(frontenwechsler),
                "total_overlap_pairs": len(overlap_matrix),
            },
        }
        with _loyalty_cache_lock:
            _loyalty_cache[cache_key] = (now, result)
        return copy.deepcopy(result)


