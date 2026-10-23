"""
System- und Docker-Container-Monitoring für TokTracker.
Erfasst Festplattenspeicher, RAM, CPU sowie Ressourcen aller Docker-Container
(toktracker_app, toktracker_db, toktracker_nginx, toktracker_ssl) und Volumes.
"""

import html
import logging
import os
import shutil
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import httpx
from config import config

logger = logging.getLogger("toktracker.system")

# Pfad zum Docker Unix Domain Socket
DOCKER_SOCKET_PATH = os.environ.get("DOCKER_SOCKET_PATH", "/var/run/docker.sock")

# Cache für System-Metriken (15 Sekunden TTL gegen Spamming)
_cached_metrics: Optional[Dict[str, Any]] = None
_cached_time: float = 0.0
_CACHE_TTL = 15.0

# Vorherige CPU-Messung für Delta-Berechnung
_last_cpu_time: float = 0.0
_last_cpu_idle: float = 0.0
_last_cpu_total: float = 0.0


def _get_host_disk_usage() -> Dict[str, Any]:
    """Liefert Gesamtkapazität, belegten und freien Festplattenspeicher in GB und Prozent."""
    try:
        du = shutil.disk_usage("/")
        total_gb = round(du.total / (1024**3), 2)
        used_gb = round(du.used / (1024**3), 2)
        free_gb = round(du.free / (1024**3), 2)
        pct = round((du.used / du.total) * 100.0, 1) if du.total > 0 else 0.0

        if pct >= 85.0:
            status = "critical"
        elif pct >= 75.0:
            status = "warning"
        else:
            status = "ok"

        return {
            "total_gb": total_gb,
            "used_gb": used_gb,
            "free_gb": free_gb,
            "percent": pct,
            "status": status,
        }
    except Exception as exc:
        logger.debug("Fehler beim Ermitteln von disk_usage: %s", exc)
        return {
            "total_gb": 0.0,
            "used_gb": 0.0,
            "free_gb": 0.0,
            "percent": 0.0,
            "status": "unknown",
        }


def _get_host_memory_usage() -> Dict[str, Any]:
    """Liest RAM-Auslastung aus /proc/meminfo."""
    try:
        mem: Dict[str, int] = {}
        if os.path.exists("/proc/meminfo"):
            with open("/proc/meminfo", "r", encoding="utf-8") as f:
                for line in f:
                    parts = line.split(":")
                    if len(parts) == 2:
                        k = parts[0].strip()
                        v = int(parts[1].split()[0])  # in kB
                        mem[k] = v

            total_mb = round(mem.get("MemTotal", 0) / 1024, 1)
            avail_mb = round(mem.get("MemAvailable", mem.get("MemFree", 0)) / 1024, 1)
            used_mb = round(total_mb - avail_mb, 1)
            pct = round((used_mb / total_mb) * 100.0, 1) if total_mb > 0 else 0.0

            if pct >= 90.0:
                status = "critical"
            elif pct >= 80.0:
                status = "warning"
            else:
                status = "ok"

            return {
                "total_mb": total_mb,
                "used_mb": used_mb,
                "free_mb": avail_mb,
                "percent": pct,
                "status": status,
            }
    except Exception as exc:
        logger.debug("Fehler beim Lesen von /proc/meminfo: %s", exc)

    return {
        "total_mb": 0.0,
        "used_mb": 0.0,
        "free_mb": 0.0,
        "percent": 0.0,
        "status": "unknown",
    }


def _get_host_cpu_usage() -> Dict[str, Any]:
    """Ermittelt aktuelle CPU-Nutzung und Load Average."""
    global _last_cpu_time, _last_cpu_idle, _last_cpu_total

    usage_pct = 0.0
    now = time.time()
    try:
        if os.path.exists("/proc/stat"):
            with open("/proc/stat", "r", encoding="utf-8") as f:
                first_line = f.readline().strip()
                fields = [float(x) for x in first_line.split()[1:]]
                idle = fields[3] + (fields[4] if len(fields) > 4 else 0.0)
                total = sum(fields)

            if _last_cpu_total > 0 and (now - _last_cpu_time) >= 0.5:
                idle_delta = idle - _last_cpu_idle
                total_delta = total - _last_cpu_total
                if total_delta > 0:
                    usage_pct = round(100.0 * (1.0 - (idle_delta / total_delta)), 1)
                    usage_pct = max(0.0, min(100.0, usage_pct))

            _last_cpu_idle = idle
            _last_cpu_total = total
            _last_cpu_time = now
    except Exception as exc:
        logger.debug("Fehler beim Ermitteln der CPU-Auslastung: %s", exc)

    load_1m, load_5m, load_15m = 0.0, 0.0, 0.0
    try:
        load_1m, load_5m, load_15m = os.getloadavg()
    except Exception:
        pass

    cores = os.cpu_count() or 1
    if usage_pct >= 90.0:
        status = "critical"
    elif usage_pct >= 75.0:
        status = "warning"
    else:
        status = "ok"

    return {
        "percent": usage_pct,
        "load_1m": round(load_1m, 2),
        "load_5m": round(load_5m, 2),
        "load_15m": round(load_15m, 2),
        "cores": cores,
        "status": status,
    }


_cached_db_storage: Optional[Dict[str, Any]] = None
_cached_db_storage_time: float = 0.0
_DB_STORAGE_CACHE_TTL = 60.0


def _get_database_storage() -> Dict[str, Any]:
    """Ermittelt die Speichergröße der Datenbank (MariaDB/MySQL oder SQLite), gecached für 60s."""
    global _cached_db_storage, _cached_db_storage_time
    now = time.time()
    if _cached_db_storage is not None and (now - _cached_db_storage_time) < _DB_STORAGE_CACHE_TTL:
        return _cached_db_storage

    try:
        from database import get_db

        if config.db_engine == "mysql":
            with get_db() as conn:
                row = conn.execute(
                    """
                    SELECT 
                        ROUND(COALESCE(SUM(data_length + index_length), 0) / 1024 / 1024, 2) AS total_mb,
                        ROUND(COALESCE(SUM(data_length), 0) / 1024 / 1024, 2) AS data_mb,
                        ROUND(COALESCE(SUM(index_length), 0) / 1024 / 1024, 2) AS index_mb,
                        COUNT(*) as table_count
                    FROM information_schema.tables 
                    WHERE table_schema = ?
                    """,
                    (config.mysql_database,),
                ).fetchone()

                if row:
                    res = {
                        "engine": "mysql",
                        "database_name": config.mysql_database,
                        "total_mb": float(row["total_mb"] or 0.0),
                        "data_mb": float(row["data_mb"] or 0.0),
                        "index_mb": float(row["index_mb"] or 0.0),
                        "table_count": int(row["table_count"] or 0),
                    }
                    _cached_db_storage = res
                    _cached_db_storage_time = now
                    return res
        else:
            db_file = config.sqlite_db_path
            size_mb = 0.0
            if os.path.exists(db_file):
                size_mb = round(os.path.getsize(db_file) / (1024 * 1024), 2)
            res = {
                "engine": "sqlite",
                "database_name": os.path.basename(db_file),
                "total_mb": size_mb,
                "data_mb": size_mb,
                "index_mb": 0.0,
                "table_count": 0,
            }
            _cached_db_storage = res
            _cached_db_storage_time = now
            return res
    except Exception as exc:
        logger.debug("Fehler beim Abfragen des Datenbank-Speichers: %s", exc)

    return {
        "engine": config.db_engine,
        "database_name": config.mysql_database if config.db_engine == "mysql" else "sqlite",
        "total_mb": 0.0,
        "data_mb": 0.0,
        "index_mb": 0.0,
        "table_count": 0,
    }


def _fetch_docker_metrics() -> Dict[str, Any]:
    """Fragt über den gemounteten Docker-Socket Metriken der TokTracker-Container & Volumes ab."""
    if not os.path.exists(DOCKER_SOCKET_PATH):
        return {
            "available": False,
            "error": f"Docker-Socket '{DOCKER_SOCKET_PATH}' nicht vorhanden (lokale Ausführung oder nicht gemountet)",
            "containers": [],
            "volumes": [],
        }

    try:
        transport = httpx.HTTPTransport(uds=DOCKER_SOCKET_PATH)
        with httpx.Client(transport=transport, timeout=2.5) as client:
            # 1. Containers schnell abfragen (OHNE teures size=true, um dockerd CPU-Spikes zu verhindern)
            c_resp = client.get("http://docker/v1.41/containers/json?all=true")
            if c_resp.status_code != 200:
                return {
                    "available": False,
                    "error": f"Docker API Antwortfehler: HTTP {c_resp.status_code}",
                    "containers": [],
                    "volumes": [],
                }
            all_containers = c_resp.json()

            # TokTracker Container filtern
            relevant_names = ("toktracker_app", "toktracker_db", "toktracker_nginx", "toktracker_ssl")
            tracked_containers: List[Dict[str, Any]] = []

            for c in all_containers:
                names = [n.lstrip("/") for n in c.get("Names", [])]
                # Prüfen, ob einer der relevanten Container-Namen passt
                matched_name = None
                for rn in relevant_names:
                    if any(rn in n for n in names):
                        matched_name = rn
                        break

                # Falls kein TokTracker-Container, ggf. trotzdem aufnehmen, wenn er "toktracker" heißt
                if not matched_name and any("toktracker" in n for n in names):
                    matched_name = names[0]

                if not matched_name:
                    continue

                cid = c.get("Id", "")[:12]
                state = c.get("State", "unknown")
                status_str = c.get("Status", "")

                # Container Stats abrufen (CPU, RAM)
                mem_used_mb = 0.0
                mem_limit_mb = 0.0
                mem_pct = 0.0
                cpu_pct = 0.0

                try:
                    s_resp = client.get(f"http://docker/v1.41/containers/{c['Id']}/stats?stream=false")
                    if s_resp.status_code == 200:
                        s_data = s_resp.json()
                        m_stats = s_data.get("memory_stats", {})
                        raw_mem = m_stats.get("usage", 0)
                        # Cache-Bereinigung, falls vom Linux-Kernel im usage enthalten
                        raw_cache = m_stats.get("stats", {}).get("inactive_file", 0)
                        actual_mem = max(0, raw_mem - raw_cache) if raw_cache else raw_mem
                        mem_limit = m_stats.get("limit", 1)

                        mem_used_mb = round(actual_mem / (1024 * 1024), 1)
                        mem_limit_mb = round(mem_limit / (1024 * 1024), 1)
                        mem_pct = round((actual_mem / mem_limit) * 100.0, 1) if mem_limit > 0 else 0.0

                        # CPU %
                        cpu_stats = s_data.get("cpu_stats", {})
                        precpu_stats = s_data.get("precpu_stats", {})
                        cpu_delta = cpu_stats.get("cpu_usage", {}).get("total_usage", 0) - precpu_stats.get("cpu_usage", {}).get("total_usage", 0)
                        sys_delta = cpu_stats.get("system_cpu_usage", 0) - precpu_stats.get("system_cpu_usage", 0)
                        online_cpus = cpu_stats.get("online_cpus") or len(cpu_stats.get("cpu_usage", {}).get("percpu_usage", [1])) or 1

                        if sys_delta > 0 and cpu_delta > 0:
                            cpu_pct = round((cpu_delta / sys_delta) * online_cpus * 100.0, 1)
                except Exception as stats_err:
                    logger.debug("Stats Fehler für Container %s: %s", matched_name, stats_err)

                tracked_containers.append({
                    "id": cid,
                    "name": matched_name,
                    "display_name": matched_name.replace("toktracker_", "").upper(),
                    "image": c.get("Image", ""),
                    "state": state,
                    "status": status_str,
                    "is_healthy": "healthy" in status_str.lower(),
                    "is_running": state == "running",
                    "size_rw_mb": round(c.get("SizeRw", 0) / (1024 * 1024), 2) if c.get("SizeRw") is not None else 0.0,
                    "size_root_fs_mb": round(c.get("SizeRootFs", 0) / (1024 * 1024), 2) if c.get("SizeRootFs") is not None else 0.0,
                    "memory_used_mb": mem_used_mb,
                    "memory_limit_mb": mem_limit_mb,
                    "memory_percent": mem_pct,
                    "memory": {
                        "used_mb": mem_used_mb,
                        "limit_mb": mem_limit_mb,
                        "percent": mem_pct,
                    },
                    "cpu_percent": cpu_pct,
                })

            # Sortieren: app, db, nginx, ssl
            order_map = {"app": 0, "db": 1, "nginx": 2, "ssl": 3}
            tracked_containers.sort(key=lambda x: order_map.get(x["name"].replace("toktracker_", ""), 99))

            # 2. Volumes & Disk Usage (/system/df)
            volumes_info: List[Dict[str, Any]] = []
            total_volumes_mb = 0.0
            total_images_mb = 0.0

            try:
                df_resp = client.get("http://docker/v1.41/system/df")
                if df_resp.status_code == 200:
                    df_data = df_resp.json()
                    v_list = df_data.get("Volumes") or []
                    for v in v_list:
                        v_name = v.get("Name", "")
                        v_size = v.get("UsageData", {}).get("Size", 0)
                        v_mb = round(v_size / (1024 * 1024), 2)
                        total_volumes_mb += v_mb

                        clean_vname = v_name
                        for pfx in ("toktrackerapp_", "toktracker_"):
                            if clean_vname.startswith(pfx):
                                clean_vname = clean_vname[len(pfx):]

                        volumes_info.append({
                            "name": clean_vname,
                            "raw_name": v_name,
                            "size_mb": v_mb,
                            "ref_count": v.get("UsageData", {}).get("RefCount", 0),
                        })

                    # Images
                    img_list = df_data.get("Images") or []
                    for img in img_list:
                        total_images_mb += round(img.get("Size", 0) / (1024 * 1024), 2)
            except Exception as df_err:
                logger.debug("DF Fehler: %s", df_err)

            return {
                "available": True,
                "socket_path": DOCKER_SOCKET_PATH,
                "containers": tracked_containers,
                "volumes": volumes_info,
                "total_volumes_mb": round(total_volumes_mb, 1),
                "total_images_mb": round(total_images_mb, 1),
            }

    except Exception as exc:
        logger.debug("Docker API Verbindungsfehler: %s", exc)
        return {
            "available": False,
            "error": str(exc),
            "containers": [],
            "volumes": [],
        }


def get_system_health(force_refresh: bool = False) -> Dict[str, Any]:
    """
    Hauptfunktion: Liefert aggregierte System- und Docker-Container-Gesundheit.
    Ergebnisse werden für 3 Sekunden zwischengespeichert.
    """
    global _cached_metrics, _cached_time

    now = time.time()
    if not force_refresh and _cached_metrics and (now - _cached_time) < _CACHE_TTL:
        return _cached_metrics

    disk = _get_host_disk_usage()
    memory = _get_host_memory_usage()
    cpu = _get_host_cpu_usage()
    database = _get_database_storage()
    docker = _fetch_docker_metrics()

    # Alerts prüfen
    alerts: List[Dict[str, Any]] = []
    if disk["percent"] >= 85.0:
        alerts.append({
            "type": "disk",
            "level": "critical" if disk["percent"] >= 90.0 else "warning",
            "message": f"Festplattenspeicher kritisch: {disk['percent']}% belegt ({disk['free_gb']} GB frei)",
        })

    if memory["percent"] >= 90.0:
        alerts.append({
            "type": "memory",
            "level": "warning",
            "message": f"RAM-Auslastung hoch: {memory['percent']}% belegt ({memory['free_mb']} MB frei)",
        })

    result = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "host": {
            "disk": disk,
            "memory": memory,
            "cpu": cpu,
        },
        "database": database,
        "docker": docker,
        "alerts": alerts,
        "is_healthy": len(alerts) == 0,
    }

    _cached_metrics = result
    _cached_time = now
    return result
