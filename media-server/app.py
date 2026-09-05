#!/usr/bin/env python3
"""
Droppr media server

Provides:
- Gallery support:
  - GET /api/share/<hash>/files: list files in a share (public, cached)
  - GET /api/share/<hash>/file/<path>: counted downloads (redirects to FileBrowser)
  - GET /api/share/<hash>/download: counted "download all" (streams FileBrowser ZIP/file)
- Admin analytics (requires FileBrowser auth token):
  - GET /api/analytics/config
  - GET /api/analytics/shares
  - GET /api/analytics/shares/<hash>
  - GET /api/analytics/shares/<hash>/export.csv
"""

from __future__ import annotations

import fcntl
import ipaddress
import csv
import json
import os
import errno
import re
import sqlite3
import threading
import time
import subprocess
import shutil
import hashlib
import hmac
import secrets
import tarfile
import io
import mimetypes
import struct
import datetime
import zlib
from contextlib import contextmanager
from urllib.parse import quote

import requests

# Try to import bcrypt, fall back to hashlib for password hashing
try:
    import bcrypt
    BCRYPT_AVAILABLE = True
except ImportError:
    BCRYPT_AVAILABLE = False
from flask import Flask, Response, jsonify, redirect, request, stream_with_context

app = Flask(__name__)

# FileBrowser API base URL (internal docker network)
FILEBROWSER_BASE_URL = os.environ.get("DROPPR_FILEBROWSER_BASE_URL", "http://droppr-app:80")
FILEBROWSER_PUBLIC_DL_API = f"{FILEBROWSER_BASE_URL}/api/public/dl"
FILEBROWSER_PUBLIC_SHARE_API = f"{FILEBROWSER_BASE_URL}/api/public/share"
FILEBROWSER_SHARES_API = f"{FILEBROWSER_BASE_URL}/api/shares"

# FileBrowser is configured with root=/srv. Mount the same data directory into this
# container so public robust-share downloads work without needing a user's X-Auth token.
FILEBROWSER_ROOT = os.path.abspath(os.environ.get("DROPPR_FILEBROWSER_ROOT", "/srv"))

SHARE_HASH_RE = re.compile(r"^[A-Za-z0-9_-]+$")
MAX_SHARE_HASH_LENGTH = 64  # Prevent DOS via extremely long hashes

# Gallery file-list caching (in-memory, per gunicorn worker)
DEFAULT_CACHE_TTL_SECONDS = int(os.environ.get("DROPPR_SHARE_CACHE_TTL_SECONDS", "3600"))
MAX_CACHE_SIZE = 1000  # Max number of shares to cache
_share_cache_lock = threading.Lock()
_share_files_cache: dict[str, tuple[float, str, list[dict]]] = {}

IMAGE_EXTS = {"jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "avif"}
VIDEO_EXTS = {"mp4", "mov", "m4v", "webm", "mkv", "avi"}


def is_valid_share_hash(share_hash: str) -> bool:
    if not share_hash or len(share_hash) > MAX_SHARE_HASH_LENGTH:
        return False
    return bool(SHARE_HASH_RE.fullmatch(share_hash))


def parse_bool(value) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "t", "yes", "y", "on"}


def _safe_rel_path(value: str) -> str | None:
    if value is None:
        return None
    value = str(value)
    if value.startswith("/") or value.startswith("\\"):
        return None
    if "\\" in value:
        return None

    parts = [p for p in value.split("/") if p]
    if not parts:
        return None
    if any(p == ".." for p in parts):
        return None
    return "/".join(parts)


def _safe_root_path(value: str) -> str | None:
    if value is None:
        return None

    value = str(value).strip()
    if not value:
        return None
    if "\\" in value:
        return None

    if not value.startswith("/"):
        value = "/" + value

    value = re.sub(r"/+", "/", value)
    parts = [p for p in value.split("/") if p]
    if not parts:
        return "/"
    if any(p == ".." for p in parts):
        return None
    return "/" + "/".join(parts)


def _encode_share_path(value: str) -> str | None:
    if value is None:
        return None

    value = str(value).strip()
    if not value:
        return None
    if "\\" in value:
        return None

    if not value.startswith("/"):
        value = "/" + value

    value = re.sub(r"/+", "/", value)
    parts = [p for p in value.split("/") if p]
    if not parts:
        return "/"
    if any(p == ".." for p in parts):
        return None

    return "/" + "/".join(quote(p, safe="") for p in parts)


def _normalize_ip(value: str | None) -> str | None:
    if not value:
        return None

    value = (value.split(",")[0] if "," in value else value).strip()

    if value.startswith("[") and "]" in value:
        value = value[1 : value.index("]")]
    elif re.fullmatch(r"\d+\.\d+\.\d+\.\d+:\d+", value):
        value = value.split(":")[0]

    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return None


ANALYTICS_DB_PATH = os.environ.get("DROPPR_ANALYTICS_DB_PATH", "/database/droppr-analytics.sqlite3")
ANALYTICS_RETENTION_DAYS = int(os.environ.get("DROPPR_ANALYTICS_RETENTION_DAYS", "180"))
ANALYTICS_ENABLED = parse_bool(os.environ.get("DROPPR_ANALYTICS_ENABLED", "true"))
ANALYTICS_LOG_GALLERY_VIEWS = parse_bool(os.environ.get("DROPPR_ANALYTICS_LOG_GALLERY_VIEWS", "true"))
ANALYTICS_LOG_FILE_DOWNLOADS = parse_bool(os.environ.get("DROPPR_ANALYTICS_LOG_FILE_DOWNLOADS", "true"))
ANALYTICS_LOG_ZIP_DOWNLOADS = parse_bool(os.environ.get("DROPPR_ANALYTICS_LOG_ZIP_DOWNLOADS", "true"))
ANALYTICS_IP_MODE = (os.environ.get("DROPPR_ANALYTICS_IP_MODE", "full") or "full").strip().lower()
ANALYTICS_DB_TIMEOUT_SECONDS = float(os.environ.get("DROPPR_ANALYTICS_DB_TIMEOUT_SECONDS", "30"))

ALIASES_DB_PATH = os.environ.get("DROPPR_ALIASES_DB_PATH", "/database/droppr-aliases.sqlite3")
ALIASES_DB_TIMEOUT_SECONDS = float(os.environ.get("DROPPR_ALIASES_DB_TIMEOUT_SECONDS", "30"))

VIDEO_META_DB_PATH = os.environ.get("DROPPR_VIDEO_META_DB_PATH", "/database/droppr-video-meta.sqlite3")
VIDEO_META_DB_TIMEOUT_SECONDS = float(os.environ.get("DROPPR_VIDEO_META_DB_TIMEOUT_SECONDS", "10"))

# Robust Shares database
ROBUST_SHARES_DB_PATH = os.environ.get("DROPPR_ROBUST_SHARES_DB_PATH", "/database/droppr-robust-shares.sqlite3")
ROBUST_SHARES_DB_TIMEOUT_SECONDS = float(os.environ.get("DROPPR_ROBUST_SHARES_DB_TIMEOUT_SECONDS", "30"))
ROBUST_SHARE_ID_RE = re.compile(r"^RS_[A-Za-z0-9_-]{12,64}$")
MAX_PASSWORD_LENGTH = 128
MAX_TITLE_LENGTH = 256
ROBUST_SHARE_CHUNK_SIZE = 65536  # 64KB chunks for streaming

# Upload Requests database (public upload links)
UPLOAD_REQUESTS_DB_PATH = os.environ.get("DROPPR_UPLOAD_REQUESTS_DB_PATH", "/database/droppr-upload-requests.sqlite3")
UPLOAD_REQUESTS_DB_TIMEOUT_SECONDS = float(os.environ.get("DROPPR_UPLOAD_REQUESTS_DB_TIMEOUT_SECONDS", "30"))
UPLOAD_REQUEST_ID_RE = re.compile(r"^UR_[A-Fa-f0-9]{24}$")
UPLOAD_REQUEST_TOKEN_HOURS = int(os.environ.get("DROPPR_UPLOAD_REQUEST_TOKEN_HOURS", "24"))
UPLOAD_REQUEST_DEFAULT_EXPIRES_HOURS = int(os.environ.get("DROPPR_UPLOAD_REQUEST_DEFAULT_EXPIRES_HOURS", "168"))
UPLOAD_REQUEST_DEFAULT_MAX_FILES = int(os.environ.get("DROPPR_UPLOAD_REQUEST_DEFAULT_MAX_FILES", "0"))
UPLOAD_REQUEST_DEFAULT_MAX_FILE_MB = int(os.environ.get("DROPPR_UPLOAD_REQUEST_DEFAULT_MAX_FILE_MB", "204800"))
UPLOAD_REQUEST_HARD_MAX_FILE_MB = int(os.environ.get("DROPPR_UPLOAD_REQUEST_HARD_MAX_FILE_MB", "204800"))
UPLOAD_REQUEST_STREAM_CHUNK_SIZE = 1024 * 1024  # 1MB chunks for streaming writes
UPLOAD_SESSION_ID_RE = re.compile(r"^US_[A-Fa-f0-9]{32}$")
UPLOAD_SESSION_ROOT = os.path.abspath(os.environ.get("DROPPR_UPLOAD_SESSION_ROOT", "/database/upload-sessions"))
UPLOAD_SESSION_CHUNK_SIZE_BYTES = int(os.environ.get("DROPPR_UPLOAD_SESSION_CHUNK_SIZE_BYTES", str(16 * 1024 * 1024)))
UPLOAD_SESSION_MAX_CHUNK_SIZE_BYTES = int(os.environ.get("DROPPR_UPLOAD_SESSION_MAX_CHUNK_SIZE_BYTES", str(64 * 1024 * 1024)))
UPLOAD_SESSION_MIN_FREE_BYTES = int(os.environ.get("DROPPR_UPLOAD_SESSION_MIN_FREE_BYTES", str(8 * 1024 * 1024 * 1024)))
UPLOAD_SESSION_STALE_TTL_SECONDS = int(os.environ.get("DROPPR_UPLOAD_SESSION_STALE_TTL_SECONDS", str(30 * 24 * 60 * 60)))
UPLOAD_SESSION_MAX_ACTIVE_PER_REQUEST = max(
    1,
    int(os.environ.get("DROPPR_UPLOAD_SESSION_MAX_ACTIVE_PER_REQUEST", "16")),
)
UPLOAD_SESSION_MAX_CHUNKS = 10000

# Settings database (admin-configurable overrides)
SETTINGS_DB_PATH = os.environ.get("DROPPR_SETTINGS_DB_PATH", "/database/droppr-settings.sqlite3")
SETTINGS_DB_TIMEOUT_SECONDS = float(os.environ.get("DROPPR_SETTINGS_DB_TIMEOUT_SECONDS", "30"))

# Upload Request notifications (webhooks)
UPLOAD_WEBHOOK_URLS = [
    u.strip()
    for u in (os.environ.get("DROPPR_UPLOAD_WEBHOOK_URL", "") or "").split(",")
    if u.strip()
]
UPLOAD_WEBHOOK_SECRET = os.environ.get("DROPPR_UPLOAD_WEBHOOK_SECRET", "") or ""
UPLOAD_WEBHOOK_TIMEOUT_SECONDS = float(os.environ.get("DROPPR_UPLOAD_WEBHOOK_TIMEOUT_SECONDS", "5"))
PUBLIC_BASE_URL = (os.environ.get("DROPPR_PUBLIC_BASE_URL", "") or "").strip().rstrip("/")

# Session/logout controls (enforced client-side by the injected Droppr panel)
SESSION_ADMIN_IDLE_MINUTES = int(os.environ.get("DROPPR_SESSION_ADMIN_IDLE_MINUTES", "240"))
SESSION_USER_IDLE_MINUTES = int(os.environ.get("DROPPR_SESSION_USER_IDLE_MINUTES", "480"))
SESSION_ADMIN_MAX_MINUTES = int(os.environ.get("DROPPR_SESSION_ADMIN_MAX_MINUTES", "720"))
SESSION_USER_MAX_MINUTES = int(os.environ.get("DROPPR_SESSION_USER_MAX_MINUTES", "1440"))
SESSION_WARNING_SECONDS = int(os.environ.get("DROPPR_SESSION_WARNING_SECONDS", "60"))

# Rate limiting for robust shares (in-memory, per worker)
_rate_limits: dict[str, list[float]] = {}
_rate_limit_lock = threading.Lock()

_last_retention_sweep_at: float = 0.0
_analytics_db_ready: bool = False
_aliases_db_ready: bool = False
_video_meta_db_ready: bool = False
_robust_shares_db_ready: bool = False
_upload_requests_db_ready: bool = False
_upload_sessions_last_cleanup_at: float = 0.0
_settings_db_ready: bool = False

SETTINGS_KEY_SESSION_ADMIN_IDLE_MINUTES = "session.admin_idle_minutes"
SETTINGS_KEY_SESSION_USER_IDLE_MINUTES = "session.user_idle_minutes"
SETTINGS_KEY_SESSION_ADMIN_MAX_MINUTES = "session.admin_max_minutes"
SETTINGS_KEY_SESSION_USER_MAX_MINUTES = "session.user_max_minutes"
SETTINGS_KEY_SESSION_WARNING_SECONDS = "session.warning_seconds"


def _schedule_upload_webhook(event_type: str, payload: dict) -> None:
    if not UPLOAD_WEBHOOK_URLS:
        return

    try:
        payload_bytes = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    except Exception:
        return

    headers = {
        "Content-Type": "application/json",
        "User-Agent": f"droppr-media-server/webhook",
        "X-Droppr-Event": str(event_type or ""),
    }

    if UPLOAD_WEBHOOK_SECRET:
        try:
            sig = hmac.new(
                UPLOAD_WEBHOOK_SECRET.encode("utf-8"),
                payload_bytes,
                hashlib.sha256,
            ).hexdigest()
            headers["X-Droppr-Signature"] = f"sha256={sig}"
        except Exception:
            pass

    urls = list(UPLOAD_WEBHOOK_URLS)
    timeout = float(UPLOAD_WEBHOOK_TIMEOUT_SECONDS or 0) or 5.0

    def _run() -> None:
        for url in urls:
            try:
                requests.post(url, data=payload_bytes, headers=headers, timeout=timeout)
            except Exception as e:
                app.logger.warning("Upload webhook failed (%s): %s", url, e)

    try:
        threading.Thread(target=_run, daemon=True).start()
    except Exception:
        _run()


def _get_client_ip() -> str | None:
    if ANALYTICS_IP_MODE == "off":
        return None

    candidates = [
        request.headers.get("CF-Connecting-IP"),
        request.headers.get("X-Forwarded-For"),
        request.headers.get("X-Real-IP"),
        request.remote_addr,
    ]

    ip = None
    for candidate in candidates:
        ip = _normalize_ip(candidate)
        if ip:
            break

    if not ip:
        return None

    if ANALYTICS_IP_MODE == "anonymized":
        try:
            addr = ipaddress.ip_address(ip)
            if isinstance(addr, ipaddress.IPv4Address):
                parts = ip.split(".")
                parts[-1] = "0"
                return ".".join(parts) + "/24"
            network = ipaddress.ip_network(f"{ip}/64", strict=False)
            return f"{network.network_address}/64"
        except ValueError:
            return None

    return ip


@contextmanager
def _analytics_conn():
    if not ANALYTICS_ENABLED:
        raise RuntimeError("Analytics disabled")

    _ensure_analytics_db()

    conn = sqlite3.connect(
        ANALYTICS_DB_PATH,
        timeout=ANALYTICS_DB_TIMEOUT_SECONDS,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
    finally:
        conn.close()


def _init_analytics_db() -> None:
    if not ANALYTICS_ENABLED:
        return

    db_dir = os.path.dirname(ANALYTICS_DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    conn = sqlite3.connect(
        ANALYTICS_DB_PATH,
        timeout=ANALYTICS_DB_TIMEOUT_SECONDS,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS download_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                share_hash TEXT NOT NULL,
                event_type TEXT NOT NULL,
                file_path TEXT,
                ip TEXT,
                user_agent TEXT,
                referer TEXT,
                created_at INTEGER NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_download_events_share_hash_created_at ON download_events(share_hash, created_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_download_events_created_at ON download_events(created_at)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_download_events_ip ON download_events(ip)")
    finally:
        conn.close()


def _ensure_analytics_db() -> None:
    global _analytics_db_ready

    if _analytics_db_ready or not ANALYTICS_ENABLED:
        return

    db_dir = os.path.dirname(ANALYTICS_DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    lock_path = f"{ANALYTICS_DB_PATH}.init.lock"
    lock_file = open(lock_path, "w")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX)

        for attempt in range(10):
            try:
                _init_analytics_db()
                _analytics_db_ready = True
                return
            except sqlite3.OperationalError as e:
                if "locked" in str(e).lower() and attempt < 9:
                    time.sleep(0.05 * (attempt + 1))
                    continue
                app.logger.warning("Analytics init failed: %s", e)
                return
            except Exception as e:
                app.logger.warning("Analytics init failed: %s", e)
                return
    finally:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_UN)
        finally:
            lock_file.close()


@contextmanager
def _aliases_conn():
    _ensure_aliases_db()

    conn = sqlite3.connect(
        ALIASES_DB_PATH,
        timeout=ALIASES_DB_TIMEOUT_SECONDS,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
    finally:
        conn.close()


def _init_aliases_db() -> None:
    db_dir = os.path.dirname(ALIASES_DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    conn = sqlite3.connect(
        ALIASES_DB_PATH,
        timeout=ALIASES_DB_TIMEOUT_SECONDS,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS share_aliases (
                from_hash TEXT PRIMARY KEY,
                to_hash TEXT NOT NULL,
                path TEXT,
                target_expire INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_share_aliases_to_hash ON share_aliases(to_hash)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_share_aliases_updated_at ON share_aliases(updated_at)")
    finally:
        conn.close()


def _ensure_aliases_db() -> None:
    global _aliases_db_ready

    if _aliases_db_ready:
        return

    db_dir = os.path.dirname(ALIASES_DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    lock_path = f"{ALIASES_DB_PATH}.init.lock"
    lock_file = open(lock_path, "w")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX)

        for attempt in range(10):
            try:
                _init_aliases_db()
                _aliases_db_ready = True
                return
            except sqlite3.OperationalError as e:
                if "locked" in str(e).lower() and attempt < 9:
                    time.sleep(0.05 * (attempt + 1))
                    continue
                app.logger.warning("Aliases init failed: %s", e)
                return
            except Exception as e:
                app.logger.warning("Aliases init failed: %s", e)
                return
    finally:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_UN)
        finally:
            lock_file.close()


def _init_video_meta_db() -> None:
    db_dir = os.path.dirname(VIDEO_META_DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    conn = sqlite3.connect(
        VIDEO_META_DB_PATH,
        timeout=VIDEO_META_DB_TIMEOUT_SECONDS,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS video_meta (
                path TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                action TEXT,
                error TEXT,
                uploaded_at INTEGER,
                processed_at INTEGER,
                original_size INTEGER,
                processed_size INTEGER,
                original_meta_json TEXT,
                processed_meta_json TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_video_meta_status ON video_meta(status)")
    finally:
        conn.close()


def _ensure_video_meta_db() -> None:
    global _video_meta_db_ready

    if _video_meta_db_ready:
        return

    db_dir = os.path.dirname(VIDEO_META_DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    lock_path = f"{VIDEO_META_DB_PATH}.init.lock"
    lock_file = open(lock_path, "w")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX)

        for attempt in range(10):
            try:
                _init_video_meta_db()
                _video_meta_db_ready = True
                return
            except sqlite3.OperationalError as e:
                if "locked" in str(e).lower() and attempt < 9:
                    time.sleep(0.05 * (attempt + 1))
                    continue
                app.logger.warning("Video meta init failed: %s", e)
                return
            except Exception as e:
                app.logger.warning("Video meta init failed: %s", e)
                return
    finally:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_UN)
        finally:
            lock_file.close()


@contextmanager
def _video_meta_conn():
    _ensure_video_meta_db()

    conn = sqlite3.connect(
        VIDEO_META_DB_PATH,
        timeout=VIDEO_META_DB_TIMEOUT_SECONDS,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    try:
        yield conn
    finally:
        conn.close()


# ============ ROBUST SHARES DATABASE ============

def _init_robust_shares_db() -> None:
    db_dir = os.path.dirname(ROBUST_SHARES_DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    conn = sqlite3.connect(
        ROBUST_SHARES_DB_PATH,
        timeout=ROBUST_SHARES_DB_TIMEOUT_SECONDS,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        # Main robust shares table
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS robust_shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                share_id TEXT UNIQUE NOT NULL,
                source_path TEXT NOT NULL,
                share_type TEXT NOT NULL,
                title TEXT,
                password_hash TEXT,
                total_size INTEGER NOT NULL DEFAULT 0,
                file_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                expires_at INTEGER,
                created_by TEXT,
                last_accessed_at INTEGER,
                access_count INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_robust_shares_share_id ON robust_shares(share_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_robust_shares_source_path ON robust_shares(source_path)")

        # Lightweight migration for older DBs (adds expires_at).
        try:
            cols = [r["name"] for r in conn.execute("PRAGMA table_info(robust_shares)").fetchall()]
            if "expires_at" not in cols:
                conn.execute("ALTER TABLE robust_shares ADD COLUMN expires_at INTEGER")
        except Exception as e:
            app.logger.warning("Robust shares migration check failed: %s", e)

        try:
            conn.execute("CREATE INDEX IF NOT EXISTS idx_robust_shares_expires_at ON robust_shares(expires_at)")
        except Exception as e:
            app.logger.warning("Robust shares expires index init failed: %s", e)

        # Files within a robust share (for selective downloads)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS robust_share_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                share_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                file_name TEXT NOT NULL,
                file_size INTEGER NOT NULL DEFAULT 0,
                file_type TEXT,
                file_extension TEXT,
                FOREIGN KEY (share_id) REFERENCES robust_shares(share_id) ON DELETE CASCADE,
                UNIQUE(share_id, file_path)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_robust_share_files_share_id ON robust_share_files(share_id)")

        # Download sessions for resume capability
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS robust_download_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT UNIQUE NOT NULL,
                share_id TEXT NOT NULL,
                download_type TEXT NOT NULL,
                selected_files TEXT,
                client_ip TEXT,
                user_agent TEXT,
                started_at INTEGER NOT NULL,
                last_activity_at INTEGER NOT NULL,
                bytes_sent INTEGER NOT NULL DEFAULT 0,
                total_bytes INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'active',
                FOREIGN KEY (share_id) REFERENCES robust_shares(share_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_robust_download_sessions_session_id ON robust_download_sessions(session_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_robust_download_sessions_share_id ON robust_download_sessions(share_id)")

        # Session tokens for password-protected shares
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS robust_share_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token_hash TEXT UNIQUE NOT NULL,
                share_id TEXT NOT NULL,
                client_ip TEXT,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                FOREIGN KEY (share_id) REFERENCES robust_shares(share_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_robust_share_tokens_token_hash ON robust_share_tokens(token_hash)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_robust_share_tokens_expires_at ON robust_share_tokens(expires_at)")
    finally:
        conn.close()


def _ensure_robust_shares_db() -> None:
    global _robust_shares_db_ready

    if _robust_shares_db_ready:
        return

    db_dir = os.path.dirname(ROBUST_SHARES_DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    lock_path = f"{ROBUST_SHARES_DB_PATH}.init.lock"
    lock_file = open(lock_path, "w")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX)

        for attempt in range(10):
            try:
                _init_robust_shares_db()
                _robust_shares_db_ready = True
                return
            except sqlite3.OperationalError as e:
                if "locked" in str(e).lower() and attempt < 9:
                    time.sleep(0.05 * (attempt + 1))
                    continue
                app.logger.warning("Robust shares init failed: %s", e)
                return
            except Exception as e:
                app.logger.warning("Robust shares init failed: %s", e)
                return
    finally:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_UN)
        finally:
            lock_file.close()


@contextmanager
def _robust_shares_conn():
    _ensure_robust_shares_db()

    conn = sqlite3.connect(
        ROBUST_SHARES_DB_PATH,
        timeout=ROBUST_SHARES_DB_TIMEOUT_SECONDS,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
    finally:
        conn.close()


# ============ UPLOAD REQUESTS DATABASE ============

def _init_upload_requests_db() -> None:
    db_dir = os.path.dirname(UPLOAD_REQUESTS_DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    conn = sqlite3.connect(
        UPLOAD_REQUESTS_DB_PATH,
        timeout=UPLOAD_REQUESTS_DB_TIMEOUT_SECONDS,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS upload_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id TEXT UNIQUE NOT NULL,
                dest_path TEXT NOT NULL,
                target_path TEXT NOT NULL,
                title TEXT,
                password_hash TEXT,
                expires_at INTEGER,
                max_files INTEGER NOT NULL DEFAULT 0,
                max_file_size_bytes INTEGER NOT NULL DEFAULT 0,
                allowed_exts_json TEXT,
                overwrite INTEGER NOT NULL DEFAULT 0,
                share_back_enabled INTEGER NOT NULL DEFAULT 0,
                share_back_share_id TEXT,
                share_back_created_at INTEGER,
                created_at INTEGER NOT NULL,
                created_by TEXT,
                disabled_at INTEGER
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_upload_requests_request_id ON upload_requests(request_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_upload_requests_expires_at ON upload_requests(expires_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_upload_requests_created_at ON upload_requests(created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_upload_requests_disabled_at ON upload_requests(disabled_at)")

        # Lightweight migrations for existing DBs.
        try:
            cols = [r["name"] for r in conn.execute("PRAGMA table_info(upload_requests)").fetchall()]
            if "share_back_enabled" not in cols:
                conn.execute("ALTER TABLE upload_requests ADD COLUMN share_back_enabled INTEGER NOT NULL DEFAULT 0")
            if "share_back_share_id" not in cols:
                conn.execute("ALTER TABLE upload_requests ADD COLUMN share_back_share_id TEXT")
            if "share_back_created_at" not in cols:
                conn.execute("ALTER TABLE upload_requests ADD COLUMN share_back_created_at INTEGER")
        except Exception as e:
            app.logger.warning("Upload requests migration check failed: %s", e)

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS upload_request_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token_hash TEXT UNIQUE NOT NULL,
                request_id TEXT NOT NULL,
                client_ip TEXT,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                FOREIGN KEY (request_id) REFERENCES upload_requests(request_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_upload_request_tokens_token_hash ON upload_request_tokens(token_hash)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_upload_request_tokens_expires_at ON upload_request_tokens(expires_at)")

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS upload_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id TEXT NOT NULL,
                original_name TEXT NOT NULL,
                stored_name TEXT NOT NULL,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                content_type TEXT,
                client_ip TEXT,
                user_agent TEXT,
                upload_session_id TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (request_id) REFERENCES upload_requests(request_id) ON DELETE CASCADE
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_upload_files_request_id_created_at ON upload_files(request_id, created_at)")
        try:
            upload_file_cols = [r["name"] for r in conn.execute("PRAGMA table_info(upload_files)").fetchall()]
            if "upload_session_id" not in upload_file_cols:
                conn.execute("ALTER TABLE upload_files ADD COLUMN upload_session_id TEXT")
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_files_upload_session_id "
                "ON upload_files(upload_session_id) WHERE upload_session_id IS NOT NULL"
            )
        except Exception as e:
            app.logger.warning("Upload files session migration check failed: %s", e)

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS upload_sessions (
                session_id TEXT PRIMARY KEY,
                resume_token_hash TEXT NOT NULL,
                request_id TEXT NOT NULL,
                original_name TEXT NOT NULL,
                stored_name TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                content_type TEXT,
                last_modified INTEGER,
                chunk_size_bytes INTEGER NOT NULL,
                chunk_count INTEGER NOT NULL,
                received_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'active',
                overwrite INTEGER NOT NULL DEFAULT 0,
                client_ip TEXT,
                user_agent TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                committed_at INTEGER,
                commit_error TEXT,
                temp_device INTEGER,
                temp_inode INTEGER,
                checksum_algorithm TEXT,
                FOREIGN KEY (request_id) REFERENCES upload_requests(request_id) ON DELETE CASCADE
            )
            """
        )
        try:
            upload_session_cols = [r["name"] for r in conn.execute("PRAGMA table_info(upload_sessions)").fetchall()]
            if "temp_device" not in upload_session_cols:
                conn.execute("ALTER TABLE upload_sessions ADD COLUMN temp_device INTEGER")
            if "temp_inode" not in upload_session_cols:
                conn.execute("ALTER TABLE upload_sessions ADD COLUMN temp_inode INTEGER")
            if "checksum_algorithm" not in upload_session_cols:
                conn.execute("ALTER TABLE upload_sessions ADD COLUMN checksum_algorithm TEXT")
        except Exception as e:
            app.logger.warning("Upload session identity migration check failed: %s", e)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_upload_sessions_request_status ON upload_sessions(request_id, status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_upload_sessions_updated_at ON upload_sessions(updated_at)")
    finally:
        conn.close()


def _ensure_upload_requests_db() -> None:
    global _upload_requests_db_ready

    if _upload_requests_db_ready:
        return

    db_dir = os.path.dirname(UPLOAD_REQUESTS_DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    lock_path = f"{UPLOAD_REQUESTS_DB_PATH}.init.lock"
    lock_file = open(lock_path, "w")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX)

        for attempt in range(10):
            try:
                _init_upload_requests_db()
                _upload_requests_db_ready = True
                return
            except sqlite3.OperationalError as e:
                if "locked" in str(e).lower() and attempt < 9:
                    time.sleep(0.05 * (attempt + 1))
                    continue
                app.logger.warning("Upload requests init failed: %s", e)
                return
            except Exception as e:
                app.logger.warning("Upload requests init failed: %s", e)
                return
    finally:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_UN)
        finally:
            lock_file.close()


@contextmanager
def _upload_requests_conn():
    _ensure_upload_requests_db()

    conn = sqlite3.connect(
        UPLOAD_REQUESTS_DB_PATH,
        timeout=UPLOAD_REQUESTS_DB_TIMEOUT_SECONDS,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
    finally:
        conn.close()


# ============ SETTINGS DATABASE ============

def _init_settings_db() -> None:
    db_dir = os.path.dirname(SETTINGS_DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    conn = sqlite3.connect(
        SETTINGS_DB_PATH,
        timeout=SETTINGS_DB_TIMEOUT_SECONDS,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS droppr_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_droppr_settings_updated_at ON droppr_settings(updated_at)")
    finally:
        conn.close()


def _ensure_settings_db() -> None:
    global _settings_db_ready

    if _settings_db_ready:
        return

    db_dir = os.path.dirname(SETTINGS_DB_PATH)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    lock_path = f"{SETTINGS_DB_PATH}.init.lock"
    lock_file = open(lock_path, "w")
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX)

        for attempt in range(10):
            try:
                _init_settings_db()
                _settings_db_ready = True
                return
            except sqlite3.OperationalError as e:
                if "locked" in str(e).lower() and attempt < 9:
                    time.sleep(0.05 * (attempt + 1))
                    continue
                app.logger.warning("Settings DB init failed: %s", e)
                return
            except Exception as e:
                app.logger.warning("Settings DB init failed: %s", e)
                return
    finally:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_UN)
        finally:
            lock_file.close()


@contextmanager
def _settings_conn():
    _ensure_settings_db()

    conn = sqlite3.connect(
        SETTINGS_DB_PATH,
        timeout=SETTINGS_DB_TIMEOUT_SECONDS,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    conn.execute("PRAGMA busy_timeout=5000;")
    try:
        yield conn
    finally:
        conn.close()


def _settings_get_value(key: str) -> str | None:
    if not key:
        return None
    try:
        with _settings_conn() as conn:
            row = conn.execute(
                "SELECT value FROM droppr_settings WHERE key = ? LIMIT 1",
                (key,),
            ).fetchone()
    except Exception:
        return None
    if not row:
        return None
    return str(row["value"]) if row["value"] is not None else None


def _settings_get_int(key: str) -> int | None:
    value = _settings_get_value(key)
    if value is None:
        return None
    try:
        return int(str(value).strip())
    except Exception:
        return None


def _settings_set_value(key: str, value: str) -> None:
    if not key:
        return
    now = int(time.time())
    with _settings_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO droppr_settings (key, value, updated_at) VALUES (?, ?, ?)",
            (key, str(value), now),
        )


def _settings_delete(key: str) -> None:
    if not key:
        return
    with _settings_conn() as conn:
        conn.execute("DELETE FROM droppr_settings WHERE key = ?", (key,))


def _get_default_session_settings() -> dict:
    def clamp(value: int, *, min_v: int = 0, max_v: int = 525600) -> int:
        try:
            n = int(value)
        except Exception:
            n = 0
        return max(min_v, min(n, max_v))

    return {
        "admin_idle_minutes": clamp(SESSION_ADMIN_IDLE_MINUTES),
        "user_idle_minutes": clamp(SESSION_USER_IDLE_MINUTES),
        "admin_max_minutes": clamp(SESSION_ADMIN_MAX_MINUTES),
        "user_max_minutes": clamp(SESSION_USER_MAX_MINUTES),
        "warning_seconds": clamp(SESSION_WARNING_SECONDS, min_v=0, max_v=3600),
    }


def _get_effective_session_settings() -> tuple[dict, dict]:
    """Returns (effective, overrides)."""
    defaults = _get_default_session_settings()
    overrides: dict[str, int] = {}

    mapping = [
        ("admin_idle_minutes", SETTINGS_KEY_SESSION_ADMIN_IDLE_MINUTES),
        ("user_idle_minutes", SETTINGS_KEY_SESSION_USER_IDLE_MINUTES),
        ("admin_max_minutes", SETTINGS_KEY_SESSION_ADMIN_MAX_MINUTES),
        ("user_max_minutes", SETTINGS_KEY_SESSION_USER_MAX_MINUTES),
        ("warning_seconds", SETTINGS_KEY_SESSION_WARNING_SECONDS),
    ]

    for field, key in mapping:
        v = _settings_get_int(key)
        if v is None:
            continue
        overrides[field] = v

    # Clamp again after applying overrides.
    out = dict(defaults)
    for k, v in overrides.items():
        out[k] = v

    def clamp_out(value: int, *, min_v: int = 0, max_v: int = 525600) -> int:
        try:
            n = int(value)
        except Exception:
            n = 0
        return max(min_v, min(n, max_v))

    out["admin_idle_minutes"] = clamp_out(out.get("admin_idle_minutes", 0))
    out["user_idle_minutes"] = clamp_out(out.get("user_idle_minutes", 0))
    out["admin_max_minutes"] = clamp_out(out.get("admin_max_minutes", 0))
    out["user_max_minutes"] = clamp_out(out.get("user_max_minutes", 0))
    out["warning_seconds"] = clamp_out(out.get("warning_seconds", 0), min_v=0, max_v=3600)

    return out, overrides


# ============ PASSWORD HASHING ============

def _hash_password(password: str) -> str:
    """Hash password using bcrypt if available, otherwise SHA-256 with salt."""
    if BCRYPT_AVAILABLE:
        return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    else:
        salt = secrets.token_hex(16)
        hashed = hashlib.sha256((salt + password).encode()).hexdigest()
        return f"sha256:{salt}:{hashed}"


def _verify_password(password: str, password_hash: str) -> bool:
    """Verify password against hash."""
    if password_hash.startswith("sha256:"):
        parts = password_hash.split(":")
        if len(parts) != 3:
            return False
        salt, stored_hash = parts[1], parts[2]
        computed_hash = hashlib.sha256((salt + password).encode()).hexdigest()
        return secrets.compare_digest(computed_hash, stored_hash)
    elif BCRYPT_AVAILABLE:
        try:
            return bcrypt.checkpw(password.encode('utf-8'), password_hash.encode('utf-8'))
        except Exception:
            return False
    return False


# ============ SESSION TOKEN MANAGEMENT ============

def _generate_session_token() -> str:
    """Generate a secure session token."""
    return secrets.token_urlsafe(32)


def _hash_session_token(token: str) -> str:
    """Hash session token for storage."""
    return hashlib.sha256(token.encode()).hexdigest()


def _create_session_token(share_id: str, client_ip: str | None = None, hours: int = 24) -> str:
    """Create and store a session token for a password-protected share."""
    token = _generate_session_token()
    token_hash = _hash_session_token(token)
    now = int(time.time())
    expires_at = now + (hours * 3600)

    with _robust_shares_conn() as conn:
        # Clean expired tokens
        conn.execute("DELETE FROM robust_share_tokens WHERE expires_at < ?", (now,))
        # Insert new token
        conn.execute(
            """
            INSERT INTO robust_share_tokens (token_hash, share_id, client_ip, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (token_hash, share_id, client_ip, now, expires_at),
        )

    return token


def _validate_session_token(token: str, share_id: str) -> bool:
    """Validate a session token for a share."""
    if not token:
        return False

    token_hash = _hash_session_token(token)
    now = int(time.time())

    with _robust_shares_conn() as conn:
        row = conn.execute(
            """
            SELECT id FROM robust_share_tokens
            WHERE token_hash = ? AND share_id = ? AND expires_at > ?
            LIMIT 1
            """,
            (token_hash, share_id, now),
        ).fetchone()
        return row is not None


# Upload Request session tokens (for password-protected upload links)
def _create_upload_request_token(request_id: str, client_ip: str | None = None, hours: int | None = None) -> str:
    token = _generate_session_token()
    token_hash = _hash_session_token(token)
    now = int(time.time())
    ttl_hours = UPLOAD_REQUEST_TOKEN_HOURS if hours is None else int(hours)
    ttl_hours = max(1, min(ttl_hours, 24 * 365))
    expires_at = now + (ttl_hours * 3600)

    with _upload_requests_conn() as conn:
        conn.execute("DELETE FROM upload_request_tokens WHERE expires_at < ?", (now,))
        conn.execute(
            """
            INSERT INTO upload_request_tokens (token_hash, request_id, client_ip, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (token_hash, request_id, client_ip, now, expires_at),
        )

    return token


def _validate_upload_request_token(token: str, request_id: str, client_ip: str | None = None) -> bool:
    if not token:
        return False

    token_hash = _hash_session_token(token)
    now = int(time.time())

    with _upload_requests_conn() as conn:
        row = conn.execute(
            """
            SELECT client_ip FROM upload_request_tokens
            WHERE token_hash = ? AND request_id = ? AND expires_at > ?
            LIMIT 1
            """,
            (token_hash, request_id, now),
        ).fetchone()
        if not row:
            return False

        stored_ip = str(row["client_ip"]) if row["client_ip"] is not None else None
        if stored_ip and client_ip and stored_ip != client_ip:
            return False

        return True


# ============ RATE LIMITING ============

def _check_rate_limit(key: str, max_requests: int = 5, window_seconds: int = 60) -> bool:
    """Check if rate limit is exceeded. Returns True if allowed, False if exceeded."""
    now = time.time()

    with _rate_limit_lock:
        if key not in _rate_limits:
            _rate_limits[key] = []

        # Clean old entries
        _rate_limits[key] = [t for t in _rate_limits[key] if now - t < window_seconds]

        if len(_rate_limits[key]) >= max_requests:
            return False

        _rate_limits[key].append(now)
        return True


# ============ ROBUST SHARE VALIDATION ============

def is_valid_robust_share_id(share_id: str) -> bool:
    if not share_id or len(share_id) > 80:
        return False
    return bool(ROBUST_SHARE_ID_RE.fullmatch(share_id))


def _generate_robust_share_id() -> str:
    """Generate a unique robust share ID."""
    return f"RS_{secrets.token_urlsafe(16)}"


# ============ UPLOAD REQUEST VALIDATION ============

def is_valid_upload_request_id(request_id: str) -> bool:
    if not request_id or len(request_id) > 64:
        return False
    return bool(UPLOAD_REQUEST_ID_RE.fullmatch(request_id))


def _generate_upload_request_id() -> str:
    # Fixed-size and URL-safe.
    return f"UR_{secrets.token_hex(12)}"


def _sanitize_title(title: str | None) -> str:
    """Sanitize and truncate title."""
    if not title:
        return ""
    return str(title).strip()[:MAX_TITLE_LENGTH]


def _content_disposition_attachment(filename: str) -> str:
    filename = (filename or "").replace("\r", " ").replace("\n", " ").strip()
    if not filename:
        filename = "download"

    # ASCII fallback for legacy clients.
    fallback = re.sub(r"[^A-Za-z0-9._-]+", "_", filename).strip("._-") or "download"
    fallback = fallback[:MAX_TITLE_LENGTH]

    # RFC 5987 encoding for UTF-8 filenames.
    utf8 = quote(filename, safe="")
    return f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{utf8}'


def _csv_safe_cell(value) -> str:
    if value is None:
        return ""
    text = str(value)
    stripped = text.lstrip()
    if stripped.startswith(("=", "+", "-", "@")):
        return "'" + text
    return text


def _csv_row(values) -> str:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow([_csv_safe_cell(v) for v in values])
    return out.getvalue()


def _robust_share_effective_title(info: dict) -> str:
    title = _sanitize_title(info.get("title"))
    if title:
        return title

    source_path = str(info.get("source_path") or "").rstrip("/")
    basename = os.path.basename(source_path)
    if basename:
        return basename[:MAX_TITLE_LENGTH]

    return str(info.get("share_id") or "share")[:MAX_TITLE_LENGTH]


def _robust_share_archive_root(info: dict) -> str:
    # Tar entry names should never be absolute or contain path separators in the prefix.
    root = _robust_share_effective_title(info)
    root = root.replace("\\", "_").replace("/", "_").strip()
    return root or "share"


def _robust_share_is_expired(info: dict, now: int | None = None) -> bool:
    ts = info.get("expires_at")
    if ts is None:
        return False
    try:
        ts_i = int(ts)
    except Exception:
        return False
    if ts_i <= 0:
        return False
    return (int(time.time()) if now is None else int(now)) >= ts_i


def _robust_share_fs_path(*, source_path: str, rel_path: str | None = None) -> str | None:
    root = FILEBROWSER_ROOT
    if not root:
        return None

    safe_source = _safe_root_path(source_path)
    if safe_source is None:
        return None

    base = os.path.join(root, safe_source.lstrip("/"))
    if rel_path is not None:
        safe_rel = _safe_rel_path(rel_path)
        if not safe_rel:
            return None
        full = os.path.join(base, *safe_rel.split("/"))
    else:
        full = base

    root_norm = os.path.normpath(root)
    full_norm = os.path.normpath(full)
    if full_norm != root_norm and not full_norm.startswith(root_norm + os.sep):
        return None

    return full_norm


# ============ UPLOAD REQUEST HELPERS ============

def _safe_upload_filename(value: str | None) -> str | None:
    if value is None:
        return None

    name = str(value).replace("\x00", "").replace("\r", " ").replace("\n", " ").strip()
    if not name:
        return None
    if "/" in name or "\\" in name:
        return None
    if name in {".", ".."}:
        return None

    # Avoid pathological filenames.
    name = name[:255].strip()
    if not name or name in {".", ".."}:
        return None

    return name


def _normalize_allowed_exts(raw) -> list[str] | None:
    if raw is None:
        return None

    values: list[str] = []
    if isinstance(raw, str):
        values = [p.strip() for p in raw.split(",") if p.strip()]
    elif isinstance(raw, list):
        values = [str(p).strip() for p in raw if p is not None and str(p).strip()]
    else:
        return None

    out: list[str] = []
    seen: set[str] = set()
    for v in values:
        ext = v.strip().lower().lstrip(".")
        if not ext:
            continue
        if not re.fullmatch(r"[a-z0-9]{1,12}", ext):
            continue
        if ext in seen:
            continue
        seen.add(ext)
        out.append(ext)

    return out or None


def _file_ext(name: str) -> str:
    return os.path.splitext(name)[1].lstrip(".").lower()


def _pick_unique_name(dest_dir: str, filename: str) -> str:
    base = filename
    stem, ext = os.path.splitext(filename)
    stem = stem[:200] or "upload"
    ext = ext[:32]

    candidate = base
    for i in range(1, 1000):
        if not os.path.exists(os.path.join(dest_dir, candidate)):
            return candidate
        candidate = f"{stem} ({i}){ext}"

    # Extremely unlikely; last resort.
    return f"{stem}-{secrets.token_hex(4)}{ext}"


class UploadSessionError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = int(status)
        self.message = str(message)


def is_valid_upload_session_id(session_id: str) -> bool:
    return bool(session_id and len(session_id) <= 64 and UPLOAD_SESSION_ID_RE.fullmatch(session_id))


def _generate_upload_session_id() -> str:
    return f"US_{secrets.token_hex(16)}"


def _choose_upload_session_chunk_size(size: int) -> int:
    chunk_size = max(5 * 1024 * 1024, int(UPLOAD_SESSION_CHUNK_SIZE_BYTES))
    max_chunk_size = max(chunk_size, int(UPLOAD_SESSION_MAX_CHUNK_SIZE_BYTES))
    while (int(size) + chunk_size - 1) // chunk_size > UPLOAD_SESSION_MAX_CHUNKS:
        chunk_size *= 2
        if chunk_size > max_chunk_size:
            raise UploadSessionError(400, "File is too large for the configured resumable chunk size")
    return chunk_size


def _upload_session_lock_path(name: str) -> str:
    if not re.fullmatch(r"(?:US_[A-Fa-f0-9]{32}|UR_[A-Fa-f0-9]{24})", str(name or "")):
        raise UploadSessionError(400, "Invalid upload lock identifier")
    lock_dir = os.path.join(UPLOAD_SESSION_ROOT, "locks")
    os.makedirs(lock_dir, mode=0o750, exist_ok=True)
    return os.path.join(lock_dir, f"{name}.lock")


@contextmanager
def _upload_session_lock(name: str):
    lock_path = _upload_session_lock_path(name)
    with open(lock_path, "a+b") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


def _load_upload_session(session_id: str) -> dict | None:
    if not is_valid_upload_session_id(session_id):
        return None
    with _upload_requests_conn() as conn:
        row = conn.execute(
            "SELECT * FROM upload_sessions WHERE session_id = ? LIMIT 1",
            (session_id,),
        ).fetchone()
    return dict(row) if row else None


def _upload_session_received(session: dict) -> set[int]:
    try:
        values = json.loads(session.get("received_json") or "[]")
    except Exception:
        values = []
    count = int(session.get("chunk_count") or 0)
    return {
        int(value)
        for value in values
        if isinstance(value, int) or (isinstance(value, str) and value.isdigit())
        if 0 <= int(value) < count
    }


def _upload_session_expected_chunk_size(session: dict, index: int) -> int:
    size = int(session.get("size_bytes") or 0)
    chunk_size = int(session.get("chunk_size_bytes") or 0)
    count = int(session.get("chunk_count") or 0)
    if index < 0 or index >= count:
        raise UploadSessionError(400, "Chunk index is out of range")
    return size - (index * chunk_size) if index == count - 1 else chunk_size


def _upload_session_received_bytes(session: dict) -> int:
    return sum(
        _upload_session_expected_chunk_size(session, index)
        for index in _upload_session_received(session)
    )


def _upload_session_status(session: dict) -> dict:
    received = sorted(_upload_session_received(session))
    count = int(session.get("chunk_count") or 0)
    return {
        "session_id": str(session.get("session_id") or ""),
        "filename": str(session.get("original_name") or ""),
        "stored_name": str(session.get("stored_name") or ""),
        "size": int(session.get("size_bytes") or 0),
        "chunk_size": int(session.get("chunk_size_bytes") or 0),
        "chunk_count": count,
        "received": received,
        "received_count": len(received),
        "bytes_received": _upload_session_received_bytes(session),
        "complete": len(received) == count,
        "committing": str(session.get("status") or "") == "committing",
        "committed": str(session.get("status") or "") == "committed",
        "commit_error": str(session.get("commit_error") or ""),
        "checksum_algorithm": str(session.get("checksum_algorithm") or ""),
    }


def _effective_upload_request_max_bytes(info: dict) -> int:
    hard_max_bytes = max(1, UPLOAD_REQUEST_HARD_MAX_FILE_MB) * 1024 * 1024
    requested = int(info.get("max_file_size_bytes") or 0)
    return hard_max_bytes if requested <= 0 else min(requested, hard_max_bytes)


def _upload_request_target_dir(info: dict) -> str:
    safe_target = _safe_root_path(str(info.get("target_path") or ""))
    if not safe_target:
        raise UploadSessionError(500, "Invalid upload target path")
    fs_target_dir = _robust_share_fs_path(source_path=safe_target)
    if not fs_target_dir:
        raise UploadSessionError(500, "Upload target is outside the storage root")
    os.makedirs(fs_target_dir, exist_ok=True)
    if not os.access(fs_target_dir, os.W_OK):
        raise UploadSessionError(403, "Target folder is not writable by the server")
    return fs_target_dir


def _upload_session_temp_path(info: dict, session_id: str) -> str:
    # Keep partial data inside the destination mount. Docker bind mounts can
    # reject hard links across mount points with EXDEV even when stat().st_dev
    # happens to match, which would make the final atomic commit fail.
    target_dir = _upload_request_target_dir(info)
    temp_dir = os.path.join(target_dir, ".droppr-upload-sessions")
    os.makedirs(temp_dir, mode=0o750, exist_ok=True)
    return os.path.join(temp_dir, f"{session_id}.part")


def _upload_session_final_path(info: dict, stored_name: str) -> str:
    name = _safe_upload_filename(stored_name)
    if not name:
        raise UploadSessionError(500, "Stored upload filename is invalid")
    return os.path.join(_upload_request_target_dir(info), name)


def _require_upload_session(request_id: str, session_id: str) -> tuple[dict, dict]:
    if not is_valid_upload_request_id(request_id) or not is_valid_upload_session_id(session_id):
        raise UploadSessionError(400, "Invalid upload session")
    session = _load_upload_session(session_id)
    if not session or str(session.get("request_id") or "") != request_id:
        raise UploadSessionError(404, "Upload session not found")
    supplied = str(request.headers.get("X-Upload-Token") or request.args.get("upload_token") or "")
    expected_hash = str(session.get("resume_token_hash") or "")
    if not supplied or not hmac.compare_digest(_hash_session_token(supplied), expected_hash):
        raise UploadSessionError(403, "Upload session token is invalid")
    info = _get_upload_request(request_id)
    if not info:
        raise UploadSessionError(404, "Upload request not found")
    if _upload_request_is_disabled(info):
        raise UploadSessionError(410, "Upload request is disabled")
    if _upload_request_is_expired(info):
        raise UploadSessionError(410, "Upload request is expired")
    return session, info


def _ensure_upload_session_space(info: dict, session: dict) -> None:
    target_dir = _upload_request_target_dir(info)
    remaining = max(0, int(session.get("size_bytes") or 0) - _upload_session_received_bytes(session))
    available = int(shutil.disk_usage(target_dir).free)
    required = remaining + max(0, int(UPLOAD_SESSION_MIN_FREE_BYTES))
    if available < required:
        raise UploadSessionError(
            507,
            f"Not enough storage available (need {required} bytes including reserve; have {available})",
        )


def _pick_upload_session_name(info: dict, filename: str, *, exclude_session_id: str | None = None) -> str:
    target_dir = _upload_request_target_dir(info)
    with _upload_requests_conn() as conn:
        params: list[object] = [info["request_id"]]
        sql = "SELECT stored_name FROM upload_sessions WHERE request_id = ? AND status IN ('active', 'committing')"
        if exclude_session_id:
            sql += " AND session_id != ?"
            params.append(exclude_session_id)
        reserved = {str(row["stored_name"]) for row in conn.execute(sql, tuple(params)).fetchall()}

    if bool(info.get("overwrite")):
        if filename in reserved:
            raise UploadSessionError(409, "An upload with this filename is already in progress")
        return filename

    stem, ext = os.path.splitext(filename)
    stem = stem[:200] or "upload"
    ext = ext[:32]
    candidate = filename
    for index in range(0, 1000):
        if candidate not in reserved and not os.path.exists(os.path.join(target_dir, candidate)):
            return candidate
        candidate = f"{stem} ({index + 1}){ext}"
    return f"{stem}-{secrets.token_hex(4)}{ext}"


def _schedule_resumable_upload_webhook(info: dict, result: dict, *, client_ip: str | None, user_agent: str | None) -> None:
    now = int(time.time())
    try:
        base = PUBLIC_BASE_URL or request.host_url.rstrip("/")
    except Exception:
        base = PUBLIC_BASE_URL or ""
    _schedule_upload_webhook(
        "upload_request.uploaded",
        {
            "event_id": secrets.token_hex(16),
            "event_type": "upload_request.uploaded",
            "created_at": now,
            "request_id": info["request_id"],
            "title": str(info.get("title") or ""),
            "dest_path": str(info.get("dest_path") or ""),
            "target_path": str(info.get("target_path") or ""),
            "upload_url": f"/upload/{info['request_id']}",
            "upload_link": (f"{base}/upload/{info['request_id']}" if base else f"/upload/{info['request_id']}"),
            "uploaded": [result],
            "uploaded_count": 1,
            "uploaded_bytes": int(result.get("size_bytes") or 0),
            "client_ip": client_ip or None,
            "user_agent": user_agent or None,
            "resumable": True,
        },
    )


def _cleanup_stale_upload_sessions_once(force: bool = False) -> None:
    global _upload_sessions_last_cleanup_at
    now = time.time()
    if not force and now - _upload_sessions_last_cleanup_at < 6 * 60 * 60:
        return

    os.makedirs(UPLOAD_SESSION_ROOT, mode=0o750, exist_ok=True)
    cleanup_lock_path = os.path.join(UPLOAD_SESSION_ROOT, "cleanup.lock")
    with open(cleanup_lock_path, "a+b") as cleanup_lock:
        try:
            fcntl.flock(cleanup_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        try:
            _upload_sessions_last_cleanup_at = now
            cutoff = int(now) - max(3600, int(UPLOAD_SESSION_STALE_TTL_SECONDS))
            with _upload_requests_conn() as conn:
                rows = conn.execute(
                    """
                    SELECT s.session_id, s.status, r.target_path
                    FROM upload_sessions s
                    JOIN upload_requests r ON r.request_id = s.request_id
                    WHERE COALESCE(s.committed_at, s.updated_at) < ?
                    LIMIT 1000
                    """,
                    (cutoff,),
                ).fetchall()

            for row in rows:
                session_id = str(row["session_id"] or "")
                if not is_valid_upload_session_id(session_id):
                    continue
                try:
                    with _upload_session_lock(session_id):
                        current = _load_upload_session(session_id)
                        if not current:
                            continue
                        touched = int(current.get("committed_at") or current.get("updated_at") or 0)
                        if touched >= cutoff:
                            continue
                        info = _get_upload_request(str(current.get("request_id") or ""))
                        if info and str(current.get("status") or "") != "committed":
                            try:
                                os.remove(_upload_session_temp_path(info, session_id))
                            except FileNotFoundError:
                                pass
                            except Exception as e:
                                app.logger.warning("Failed to remove stale upload data %s: %s", session_id, e)
                        with _upload_requests_conn() as conn:
                            conn.execute("DELETE FROM upload_sessions WHERE session_id = ?", (session_id,))
                    try:
                        os.remove(_upload_session_lock_path(session_id))
                    except FileNotFoundError:
                        pass
                except Exception as e:
                    app.logger.warning("Stale upload cleanup skipped %s: %s", session_id, e)
        finally:
            fcntl.flock(cleanup_lock, fcntl.LOCK_UN)


def _get_upload_request(request_id: str) -> dict | None:
    with _upload_requests_conn() as conn:
        row = conn.execute(
            """
            SELECT
                request_id,
                dest_path,
                target_path,
                title,
                password_hash,
                expires_at,
                max_files,
                max_file_size_bytes,
                allowed_exts_json,
                overwrite,
                share_back_enabled,
                share_back_share_id,
                share_back_created_at,
                created_at,
                created_by,
                disabled_at
            FROM upload_requests
            WHERE request_id = ?
            LIMIT 1
            """,
            (request_id,),
        ).fetchone()

    if not row:
        return None

    allowed_exts = None
    try:
        if row["allowed_exts_json"]:
            parsed = json.loads(row["allowed_exts_json"])
            allowed_exts = _normalize_allowed_exts(parsed)
    except Exception:
        allowed_exts = None

    return {
        "request_id": str(row["request_id"]),
        "dest_path": str(row["dest_path"]),
        "target_path": str(row["target_path"]),
        "title": str(row["title"] or ""),
        "password_protected": bool(row["password_hash"]),
        "password_hash": (str(row["password_hash"]) if row["password_hash"] else None),
        "expires_at": int(row["expires_at"] or 0) if row["expires_at"] else None,
        "max_files": int(row["max_files"] or 0),
        "max_file_size_bytes": int(row["max_file_size_bytes"] or 0),
        "allowed_exts": allowed_exts,
        "overwrite": bool(int(row["overwrite"] or 0)),
        "share_back_enabled": bool(int(row["share_back_enabled"] or 0)),
        "share_back_share_id": (str(row["share_back_share_id"]) if row["share_back_share_id"] else None),
        "share_back_created_at": int(row["share_back_created_at"] or 0) if row["share_back_created_at"] else None,
        "created_at": int(row["created_at"] or 0),
        "created_by": (str(row["created_by"]) if row["created_by"] else None),
        "disabled_at": int(row["disabled_at"] or 0) if row["disabled_at"] else None,
    }


def _upload_request_is_expired(info: dict, now: int | None = None) -> bool:
    ts = info.get("expires_at")
    if ts is None:
        return False
    try:
        ts_i = int(ts)
    except Exception:
        return False
    if ts_i <= 0:
        return False
    return (int(time.time()) if now is None else int(now)) >= ts_i


def _upload_request_is_disabled(info: dict) -> bool:
    return info.get("disabled_at") is not None


def _parse_single_range(range_header: str | None, size: int) -> tuple[int, int] | None:
    if not range_header:
        return None

    m = re.match(r"^bytes=(\d*)-(\d*)$", range_header.strip())
    if not m:
        raise ValueError("Invalid Range header")

    start_s, end_s = m.groups()
    if start_s == "" and end_s == "":
        raise ValueError("Invalid Range header")

    if start_s == "":
        # Suffix range: last N bytes
        suffix_len = int(end_s)
        if suffix_len <= 0:
            raise ValueError("Invalid Range header")
        suffix_len = min(suffix_len, size)
        return max(size - suffix_len, 0), size - 1

    start = int(start_s)
    end = int(end_s) if end_s else size - 1
    if start >= size:
        raise ValueError("Range start out of bounds")
    end = min(end, size - 1)
    if end < start:
        raise ValueError("Invalid Range header")
    return start, end


def _tar_padding(size: int) -> int:
    return (512 - (size % 512)) % 512


ZIP_LOCAL_FILE_HEADER_SIG = 0x04034B50
ZIP_DATA_DESCRIPTOR_SIG = 0x08074B50
ZIP_CENTRAL_DIR_HEADER_SIG = 0x02014B50
ZIP_END_CENTRAL_DIR_SIG = 0x06054B50
ZIP64_END_CENTRAL_DIR_SIG = 0x06064B50
ZIP64_END_CENTRAL_DIR_LOCATOR_SIG = 0x07064B50

ZIP_VERSION_DEFAULT = 20
ZIP_VERSION_ZIP64 = 45
ZIP_FLAG_DATA_DESCRIPTOR = 0x0008
ZIP_FLAG_UTF8 = 0x0800
ZIP_METHOD_STORE = 0
ZIP_EXTRA_ZIP64 = 0x0001


def _zip_dos_time_date(unix_ts: int) -> tuple[int, int]:
    """Return (dos_time, dos_date)."""
    try:
        dt = datetime.datetime.fromtimestamp(int(unix_ts))
    except Exception:
        dt = datetime.datetime(1980, 1, 1)

    if dt.year < 1980:
        dt = datetime.datetime(1980, 1, 1)

    dos_time = (dt.hour << 11) | (dt.minute << 5) | (dt.second // 2)
    dos_date = ((dt.year - 1980) << 9) | (dt.month << 5) | dt.day
    return dos_time & 0xFFFF, dos_date & 0xFFFF


def _zip_extra_zip64_local(*, size: int) -> bytes:
    # Zip64 extended information extra field: uncompressed size + compressed size (8 bytes each).
    data = struct.pack("<QQ", int(size), int(size))
    return struct.pack("<HH", ZIP_EXTRA_ZIP64, len(data)) + data


def _zip_extra_zip64_central(*, size: int | None, offset: int | None) -> bytes:
    # Include only values that overflow their 32-bit fields, in spec order:
    # uncompressed size, compressed size, local header offset.
    parts: list[bytes] = []
    if size is not None:
        parts.append(struct.pack("<QQ", int(size), int(size)))
    if offset is not None:
        parts.append(struct.pack("<Q", int(offset)))
    data = b"".join(parts)
    return struct.pack("<HH", ZIP_EXTRA_ZIP64, len(data)) + data


def _zip_local_header(*, name: bytes, mtime: int, size: int, zip64_sizes: bool) -> bytes:
    dos_time, dos_date = _zip_dos_time_date(mtime)
    flags = ZIP_FLAG_UTF8 | ZIP_FLAG_DATA_DESCRIPTOR
    version = ZIP_VERSION_ZIP64 if zip64_sizes else ZIP_VERSION_DEFAULT

    extra = _zip_extra_zip64_local(size=size) if zip64_sizes else b""
    crc32 = 0
    if zip64_sizes:
        comp_size = uncomp_size = 0xFFFFFFFF
    else:
        comp_size = uncomp_size = 0

    header = struct.pack(
        "<IHHHHHIIIHH",
        ZIP_LOCAL_FILE_HEADER_SIG,
        version,
        flags,
        ZIP_METHOD_STORE,
        dos_time,
        dos_date,
        crc32,
        comp_size,
        uncomp_size,
        len(name),
        len(extra),
    )
    return header + name + extra


def _zip_data_descriptor(*, crc32: int, size: int, zip64_sizes: bool) -> bytes:
    crc32 = int(crc32) & 0xFFFFFFFF
    size = int(size)
    if zip64_sizes:
        return struct.pack("<IIQQ", ZIP_DATA_DESCRIPTOR_SIG, crc32, size, size)
    return struct.pack("<IIII", ZIP_DATA_DESCRIPTOR_SIG, crc32, size, size)


def _zip_central_header(
    *,
    name: bytes,
    mtime: int,
    crc32: int,
    size: int,
    local_header_offset: int,
    zip64_sizes: bool,
    zip64_offset: bool,
) -> bytes:
    dos_time, dos_date = _zip_dos_time_date(mtime)
    flags = ZIP_FLAG_UTF8 | ZIP_FLAG_DATA_DESCRIPTOR

    version_needed = ZIP_VERSION_ZIP64 if (zip64_sizes or zip64_offset) else ZIP_VERSION_DEFAULT
    version_made_by = ZIP_VERSION_ZIP64

    crc32 = int(crc32) & 0xFFFFFFFF
    size = int(size)
    local_header_offset = int(local_header_offset)

    comp_size = 0xFFFFFFFF if zip64_sizes else size
    uncomp_size = 0xFFFFFFFF if zip64_sizes else size
    offset_field = 0xFFFFFFFF if zip64_offset else local_header_offset

    extra = b""
    if zip64_sizes or zip64_offset:
        extra = _zip_extra_zip64_central(
            size=size if zip64_sizes else None,
            offset=local_header_offset if zip64_offset else None,
        )

    header = struct.pack(
        "<IHHHHHHIIIHHHHHII",
        ZIP_CENTRAL_DIR_HEADER_SIG,
        version_made_by,
        version_needed,
        flags,
        ZIP_METHOD_STORE,
        dos_time,
        dos_date,
        crc32,
        comp_size,
        uncomp_size,
        len(name),
        len(extra),
        0,  # comment length
        0,  # disk start
        0,  # internal attrs
        0,  # external attrs
        offset_field,
    )
    return header + name + extra


def _zip_end_of_central_directory(
    *,
    entries: int,
    cd_size: int,
    cd_offset: int,
) -> bytes:
    entries = int(entries)
    cd_size = int(cd_size)
    cd_offset = int(cd_offset)

    needs_zip64 = entries >= 0xFFFF or cd_size >= 0xFFFFFFFF or cd_offset >= 0xFFFFFFFF

    out = bytearray()
    if needs_zip64:
        zip64_eocd_offset = cd_offset + cd_size
        out += struct.pack(
            "<IQHHIIQQQQ",
            ZIP64_END_CENTRAL_DIR_SIG,
            44,  # size of zip64 EOCD record (excluding signature and this field)
            ZIP_VERSION_ZIP64,
            ZIP_VERSION_ZIP64,
            0,
            0,
            entries,
            entries,
            cd_size,
            cd_offset,
        )
        out += struct.pack(
            "<IIQI",
            ZIP64_END_CENTRAL_DIR_LOCATOR_SIG,
            0,
            zip64_eocd_offset,
            1,
        )

    out += struct.pack(
        "<IHHHHIIH",
        ZIP_END_CENTRAL_DIR_SIG,
        0,
        0,
        0xFFFF if needs_zip64 else entries,
        0xFFFF if needs_zip64 else entries,
        0xFFFFFFFF if needs_zip64 else cd_size,
        0xFFFFFFFF if needs_zip64 else cd_offset,
        0,
    )

    return bytes(out)


def _zip_member_name_bytes(name: str) -> bytes:
    name = str(name or "").replace("\0", "").strip()
    name = name.lstrip("/").replace("\\", "/")
    name = re.sub(r"/+", "/", name).strip()
    if not name or name in {".", ".."}:
        name = "file"
    return name.encode("utf-8", errors="replace")


def _sanitize_tar_member_name(name: str) -> str:
    name = str(name or "").replace("\0", "").strip()
    name = name.replace("\\", "_").replace("/", "_")
    name = re.sub(r"\\s+", " ", name).strip()
    if not name or name in {".", ".."}:
        return "file"
    return name[:MAX_TITLE_LENGTH]


def _unique_flat_tar_names(paths: list[str]) -> dict[str, str]:
    """Return a mapping of original paths -> unique flat tar member names."""
    parts_by_path: dict[str, list[str]] = {}
    max_depth = 1

    for path in paths:
        raw = str(path or "")
        parts = [p for p in raw.split("/") if p]
        if not parts:
            parts = [raw] if raw else ["file"]
        parts_by_path[path] = parts
        max_depth = max(max_depth, len(parts))

    depth = 1
    names: dict[str, str] = {}
    while depth <= max_depth:
        counts: dict[str, int] = {}
        for path, parts in parts_by_path.items():
            take = parts[-depth:]
            candidate = _sanitize_tar_member_name("__".join(take))
            names[path] = candidate
            counts[candidate] = counts.get(candidate, 0) + 1
        if all(c == 1 for c in counts.values()):
            break
        depth += 1

    # Final disambiguation with numeric suffixes if still needed.
    used: dict[str, int] = {}
    final: dict[str, str] = {}
    for path in paths:
        candidate = names.get(path) or _sanitize_tar_member_name(os.path.basename(str(path)))
        idx = used.get(candidate, 0) + 1
        used[candidate] = idx
        if idx == 1:
            final[path] = candidate
            continue

        base, ext = os.path.splitext(candidate)
        suffixed = f"{base}_{idx}{ext}" if ext else f"{candidate}_{idx}"
        final[path] = _sanitize_tar_member_name(suffixed)

    return final


# ============ ROBUST SHARE HELPERS ============

def _get_robust_share_info(share_id: str) -> dict | None:
    """Get robust share info from database."""
    with _robust_shares_conn() as conn:
        row = conn.execute(
            """
            SELECT share_id, source_path, share_type, title, password_hash,
                   total_size, file_count, created_at, expires_at, last_accessed_at, access_count
            FROM robust_shares
            WHERE share_id = ?
            LIMIT 1
            """,
            (share_id,),
        ).fetchone()

        if not row:
            return None

        return {
            "share_id": row["share_id"],
            "source_path": row["source_path"],
            "share_type": row["share_type"],
            "title": row["title"],
            "password_protected": bool(row["password_hash"]),
            "total_size": row["total_size"],
            "file_count": row["file_count"],
            "created_at": row["created_at"],
            "expires_at": int(row["expires_at"] or 0) if row["expires_at"] else None,
            "last_accessed_at": row["last_accessed_at"],
            "access_count": row["access_count"],
        }


def _get_robust_share_password_hash(share_id: str) -> str | None:
    """Get password hash for a robust share."""
    with _robust_shares_conn() as conn:
        row = conn.execute(
            "SELECT password_hash FROM robust_shares WHERE share_id = ? LIMIT 1",
            (share_id,),
        ).fetchone()
        return row["password_hash"] if row else None


def _update_robust_share_access(share_id: str) -> None:
    """Update last access time and count for a robust share."""
    now = int(time.time())
    with _robust_shares_conn() as conn:
        conn.execute(
            """
            UPDATE robust_shares
            SET last_accessed_at = ?, access_count = access_count + 1
            WHERE share_id = ?
            """,
            (now, share_id),
        )


def _get_robust_share_files(share_id: str) -> list[dict]:
    """Get all files for a robust share."""
    with _robust_shares_conn() as conn:
        rows = conn.execute(
            """
            SELECT file_path, file_name, file_size, file_type, file_extension
            FROM robust_share_files
            WHERE share_id = ?
            ORDER BY file_path
            """,
            (share_id,),
        ).fetchall()

        return [
            {
                "path": row["file_path"],
                "name": row["file_name"],
                "size": row["file_size"],
                "type": row["file_type"],
                "extension": row["file_extension"],
            }
            for row in rows
        ]


def _scan_and_store_files(share_id: str, source_path: str, share_type: str) -> tuple[int, int]:
    """Scan source path and store file info in database. Returns (file_count, total_size)."""
    files = []
    total_size = 0

    if share_type == "file":
        fs_path = _robust_share_fs_path(source_path=source_path)
        if fs_path and os.path.isfile(fs_path):
            name = os.path.basename(source_path.rstrip("/")) or os.path.basename(fs_path) or "file"
            ext = os.path.splitext(name)[1].lstrip(".").lower()
            ftype = _infer_gallery_type({}, ext)
            try:
                st = os.stat(fs_path)
                size = int(st.st_size)
            except Exception:
                size = 0
            files.append(
                {
                    "path": name,
                    "name": name,
                    "size": size,
                    "type": ftype,
                    "extension": ext,
                }
            )
            total_size = size
    else:
        fs_root = _robust_share_fs_path(source_path=source_path)
        if fs_root and os.path.isdir(fs_root):
            for root, dirs, filenames in os.walk(fs_root, topdown=True, followlinks=False):
                for fname in filenames:
                    full = os.path.join(root, fname)
                    try:
                        if os.path.islink(full):
                            continue
                        st = os.stat(full)
                    except Exception:
                        continue

                    size = int(st.st_size or 0)
                    rel = os.path.relpath(full, fs_root)
                    rel = rel.replace(os.sep, "/")

                    ext = os.path.splitext(fname)[1].lstrip(".").lower()
                    ftype = _infer_gallery_type({}, ext)

                    files.append(
                        {
                            "path": rel,
                            "name": fname,
                            "size": size,
                            "type": ftype,
                            "extension": ext,
                        }
                    )
                    total_size += size

    # Store files in database
    with _robust_shares_conn() as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute("DELETE FROM robust_share_files WHERE share_id = ?", (share_id,))

            for f in files:
                conn.execute(
                    """
                    INSERT INTO robust_share_files (share_id, file_path, file_name, file_size, file_type, file_extension)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (share_id, f["path"], f["name"], f["size"], f["type"], f["extension"]),
                )

            conn.execute(
                """
                UPDATE robust_shares
                SET total_size = ?, file_count = ?
                WHERE share_id = ?
                """,
                (total_size, len(files), share_id),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

    return len(files), total_size


MAX_ALIAS_DEPTH = 10


def _resolve_share_hash(share_hash: str) -> str:
    if not is_valid_share_hash(share_hash):
        return share_hash

    current = share_hash
    visited = {current}
    try:
        with _aliases_conn() as conn:
            for _ in range(MAX_ALIAS_DEPTH):
                row = conn.execute(
                    "SELECT to_hash FROM share_aliases WHERE from_hash = ? LIMIT 1",
                    (current,),
                ).fetchone()
                if row is None:
                    break
                nxt = str(row["to_hash"] or "").strip()
                if not is_valid_share_hash(nxt) or nxt in visited:
                    break
                visited.add(nxt)
                current = nxt
    except Exception:
        return share_hash

    return current


def _upsert_share_alias(*, from_hash: str, to_hash: str, path: str | None, target_expire: int | None) -> None:
    if not is_valid_share_hash(from_hash) or not is_valid_share_hash(to_hash):
        raise ValueError("Invalid share hash")

    now = int(time.time())
    with _aliases_conn() as conn:
        conn.execute(
            """
            INSERT INTO share_aliases (from_hash, to_hash, path, target_expire, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(from_hash) DO UPDATE SET
                to_hash = excluded.to_hash,
                path = excluded.path,
                target_expire = excluded.target_expire,
                updated_at = excluded.updated_at
            """,
            (from_hash, to_hash, path, target_expire, now, now),
        )


def _list_share_aliases(*, limit: int = 500) -> list[dict]:
    limit = max(1, min(int(limit or 500), 5000))
    with _aliases_conn() as conn:
        rows = conn.execute(
            """
            SELECT from_hash, to_hash, path, target_expire, created_at, updated_at
            FROM share_aliases
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    result = []
    for row in rows:
        result.append(
            {
                "from_hash": str(row["from_hash"]),
                "to_hash": str(row["to_hash"]),
                "path": row["path"],
                "target_expire": int(row["target_expire"] or 0) if row["target_expire"] else None,
                "created_at": int(row["created_at"] or 0) if row["created_at"] else None,
                "updated_at": int(row["updated_at"] or 0) if row["updated_at"] else None,
            }
        )

    return result


def _maybe_apply_retention(conn: sqlite3.Connection) -> None:
    global _last_retention_sweep_at

    if ANALYTICS_RETENTION_DAYS <= 0:
        return

    now = time.time()
    if now - _last_retention_sweep_at < 3600:
        return

    cutoff = int(now - (ANALYTICS_RETENTION_DAYS * 86400))
    try:
        conn.execute("DELETE FROM download_events WHERE created_at < ?", (cutoff,))
    finally:
        _last_retention_sweep_at = now


def _should_log_event(event_type: str) -> bool:
    if not ANALYTICS_ENABLED:
        return False
    if event_type == "gallery_view":
        return ANALYTICS_LOG_GALLERY_VIEWS
    if event_type == "file_download":
        return ANALYTICS_LOG_FILE_DOWNLOADS
    if event_type == "zip_download":
        return ANALYTICS_LOG_ZIP_DOWNLOADS
    return True


def _log_event(event_type: str, share_hash: str, file_path: str | None = None) -> None:
    if not _should_log_event(event_type):
        return

    ip = _get_client_ip()
    user_agent = request.headers.get("User-Agent")
    referer = request.headers.get("Referer")
    created_at = int(time.time())

    for attempt in range(3):
        try:
            with _analytics_conn() as conn:
                _maybe_apply_retention(conn)
                conn.execute(
                    """
                    INSERT INTO download_events (share_hash, event_type, file_path, ip, user_agent, referer, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (share_hash, event_type, file_path, ip, user_agent, referer, created_at),
                )
            return
        except sqlite3.OperationalError as e:
            if "locked" not in str(e).lower() or attempt == 2:
                app.logger.warning("Analytics logging failed: %s", e)
                return
            time.sleep(0.05 * (attempt + 1))
        except Exception as e:
            app.logger.warning("Analytics logging failed: %s", e)
            return


def _get_auth_token() -> str | None:
    token = request.headers.get("X-Auth")
    if token:
        return token.strip()

    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()

    cookie_token = request.cookies.get("auth")
    if cookie_token:
        return cookie_token.strip()

    return None


def _validate_filebrowser_admin(token: str) -> int | None:
    resp = requests.get(f"{FILEBROWSER_BASE_URL}/api/users", headers={"X-Auth": token}, timeout=10)
    if resp.status_code in {401, 403}:
        return resp.status_code
    resp.raise_for_status()
    return None


def _admin_auth_error_response():
    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        status = _validate_filebrowser_admin(token)
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502

    if status is not None:
        return jsonify({"error": "Unauthorized"}), status

    return None


def _parse_non_negative_int(value, default: int = 0, max_value: int | None = None) -> int:
    try:
        out = int(str(value).strip())
    except Exception:
        out = int(default)
    out = max(0, out)
    if max_value is not None:
        out = min(int(max_value), out)
    return out


def _create_filebrowser_share(*, token: str, path_encoded: str, hours: int) -> dict:
    body = {"password": "", "expires": "", "unit": "hours"}
    if hours > 0:
        body["expires"] = str(hours)

    resp = requests.post(
        f"{FILEBROWSER_BASE_URL}/api/share{path_encoded}",
        headers={"X-Auth": token, "Content-Type": "application/json"},
        json=body,
        timeout=10,
    )
    if resp.status_code in {401, 403}:
        raise PermissionError("Unauthorized")
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, dict) else {}


def _fetch_filebrowser_shares(token: str) -> list[dict]:
    # TEMPORARY FIX: Disable fetching shares to prevent FileBrowser panic (slice bounds out of range)
    # The endpoint GET /api/shares seems to crash the current FileBrowser instance.
    # TODO: Re-enable once FileBrowser is updated or the root cause is fixed.
    app.logger.warning("Skipping _fetch_filebrowser_shares to prevent crash")
    return []

    # Original code commented out:
    # resp = requests.get(FILEBROWSER_SHARES_API, headers={"X-Auth": token}, timeout=10)
    # if resp.status_code in {401, 403}:
    #     raise PermissionError("Unauthorized")
    # resp.raise_for_status()
    # data = resp.json()
    # if isinstance(data, list):
    #     return [item for item in data if isinstance(item, dict)]
    # return []


def _parse_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


MAX_ANALYTICS_DAYS = 3650  # Max 10 years for analytics queries


def _get_time_range() -> tuple[int, int]:
    now = int(time.time())

    days = _parse_int(request.args.get("days"))
    if days is not None and days > 0:
        days = min(days, MAX_ANALYTICS_DAYS)  # Cap to prevent extreme queries
        return now - (days * 86400), now

    since = _parse_int(request.args.get("since"))
    until = _parse_int(request.args.get("until"))
    return max(0, since or 0), max(0, until or now)


def _fetch_public_share_json(share_hash: str, subpath: str | None = None) -> dict | None:
    if subpath:
        # subpath expected to start with "/"
        subpath = "/" + subpath.lstrip("/")
        url = f"{FILEBROWSER_PUBLIC_SHARE_API}/{share_hash}{quote(subpath, safe='/')}"
    else:
        url = f"{FILEBROWSER_PUBLIC_SHARE_API}/{share_hash}"

    resp = requests.get(url, timeout=10)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, dict) else None


def _infer_folder_share_entry_subpath(meta: dict) -> str | None:
    """
    FileBrowser folder shares expose the *parent* directory at `/api/public/share/<hash>`, with the
    shared folder itself present as an entry whose name matches `meta["name"]`.

    Return the shared folder entry path (e.g. "/OSW" or "/nested") so Droppr can start browsing
    inside the actual shared folder instead of the parent.
    """
    if not isinstance(meta, dict):
        return None

    items = meta.get("items")
    if not isinstance(items, list):
        return None

    share_name = meta.get("name")
    if not isinstance(share_name, str) or not share_name.strip():
        return None
    share_name = share_name.strip()

    for item in items:
        if not isinstance(item, dict):
            continue
        if (item.get("name") or "").strip() != share_name:
            continue
        if not parse_bool(item.get("isDir")):
            continue
        item_path = item.get("path")
        if isinstance(item_path, str) and item_path.startswith("/"):
            return item_path
    return None


def _infer_gallery_type(item: dict, extension: str) -> str:
    raw_type = (item.get("type") or "").strip().lower()
    if raw_type in {"image", "video"}:
        return raw_type
    if extension in IMAGE_EXTS:
        return "image"
    if extension in VIDEO_EXTS:
        return "video"
    return "file"


def _build_folder_structure(*, request_hash: str, source_hash: str, root: dict, subpath: str = "") -> dict:
    """Build folder structure with folders and files (non-recursive, single level)."""
    items: list[dict] = []
    folders: list[dict] = []
    files: list[dict] = []

    root_items = root.get("items")
    if not isinstance(root_items, list):
        return {"folders": [], "files": [], "path": subpath}

    for item in root_items:
        if not isinstance(item, dict):
            continue

        raw_path = item.get("path", "")
        if not isinstance(raw_path, str) or not raw_path:
            continue

        rel_path = raw_path[1:] if raw_path.startswith("/") else raw_path
        rel_path = _safe_rel_path(rel_path)
        if not rel_path:
            continue

        name = item.get("name") if isinstance(item.get("name"), str) else os.path.basename(rel_path)

        if item.get("isDir"):
            folders.append({
                "name": name,
                "path": rel_path,
                "type": "folder",
                "size": int(item.get("size") or 0),
            })
        else:
            ext = item.get("extension") if isinstance(item.get("extension"), str) else ""
            ext = ext[1:] if ext.startswith(".") else ext
            ext = ext.lower()

            files.append({
                "name": name,
                "path": rel_path,
                "type": _infer_gallery_type(item, ext),
                "extension": ext,
                "size": int(item.get("size") or 0),
                "inline_url": f"/api/public/dl/{source_hash}/{quote(rel_path, safe='/')}?inline=true",
                "download_url": f"/api/share/{request_hash}/file/{quote(rel_path, safe='/')}?download=1",
            })

    # Sort folders first by name, then files by name
    folders.sort(key=lambda x: x.get("name", "").lower())
    files.sort(key=lambda x: x.get("name", "").lower())

    return {
        "folders": folders,
        "files": files,
        "path": subpath,
        "has_folders": len(folders) > 0,
    }


def _build_folder_share_file_list(*, request_hash: str, source_hash: str, root: dict) -> list[dict]:
    files: list[dict] = []
    dirs_to_scan: list[str] = []
    visited_dirs: set[str] = set()

    root_items = root.get("items")
    if not isinstance(root_items, list):
        return files

    for item in root_items:
        if not isinstance(item, dict):
            continue
        if item.get("isDir"):
            path = item.get("path")
            if isinstance(path, str) and path.startswith("/"):
                dirs_to_scan.append(path)
            continue
        files.append(item)

    while dirs_to_scan:
        dir_path = dirs_to_scan.pop()
        if dir_path in visited_dirs:
            continue
        visited_dirs.add(dir_path)

        data = _fetch_public_share_json(source_hash, subpath=dir_path)
        if not data:
            continue
        items = data.get("items")
        if not isinstance(items, list):
            continue

        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("isDir"):
                path = item.get("path")
                if isinstance(path, str) and path.startswith("/"):
                    dirs_to_scan.append(path)
                continue
            files.append(item)

    # Normalize, remove directories, and enrich with URLs
    result = []
    for item in files:
        raw_path = item.get("path")
        if not isinstance(raw_path, str) or not raw_path:
            continue
        rel_path = raw_path[1:] if raw_path.startswith("/") else raw_path
        rel_path = _safe_rel_path(rel_path)
        if not rel_path:
            continue

        name = item.get("name") if isinstance(item.get("name"), str) else os.path.basename(rel_path)
        ext = item.get("extension") if isinstance(item.get("extension"), str) else ""
        ext = ext[1:] if ext.startswith(".") else ext
        ext = ext.lower()

        result.append(
            {
                "name": name,
                "path": rel_path,
                "type": _infer_gallery_type(item, ext),
                "extension": ext,
                "size": int(item.get("size") or 0),
                "inline_url": f"/api/public/dl/{source_hash}/{quote(rel_path, safe='/')}?inline=true",
                "download_url": f"/api/share/{request_hash}/file/{quote(rel_path, safe='/')}?download=1",
            }
        )

    return result


def _build_file_share_file_list(*, request_hash: str, source_hash: str, meta: dict) -> list[dict]:
    raw_path = meta.get("path")
    name = meta.get("name")
    if not isinstance(name, str) or not name:
        if isinstance(raw_path, str) and raw_path:
            name = os.path.basename(raw_path)
        else:
            name = source_hash

    ext = meta.get("extension") if isinstance(meta.get("extension"), str) else ""
    ext = ext[1:] if ext.startswith(".") else ext
    ext = ext.lower()

    return [
        {
            "name": name,
            "path": name,
            "type": _infer_gallery_type(meta, ext),
            "extension": ext,
            "size": int(meta.get("size") or 0),
            # NOTE: /api/public/dl/<hash> is redirected to /gallery/<hash> by nginx, so we expose
            # a separate nginx route that proxies to FileBrowser without redirect.
            "inline_url": f"/api/public/file/{source_hash}?inline=true",
            "download_url": f"/api/share/{request_hash}/download",
        }
    ]


def _get_share_files(
    request_hash: str, *, source_hash: str, force_refresh: bool, max_age_seconds: int
) -> list[dict] | None:
    now = time.time()
    if not force_refresh:
        with _share_cache_lock:
            cached = _share_files_cache.get(request_hash)
            if cached and (now - cached[0]) < max_age_seconds and cached[1] == source_hash:
                return cached[2]

    data = _fetch_public_share_json(source_hash)
    if not data:
        return None

    if isinstance(data.get("items"), list):
        entry_subpath = _infer_folder_share_entry_subpath(data)
        if entry_subpath:
            entry = _fetch_public_share_json(source_hash, subpath=entry_subpath)
            if entry and isinstance(entry.get("items"), list):
                data = entry

        files = _build_folder_share_file_list(request_hash=request_hash, source_hash=source_hash, root=data)
    else:
        files = _build_file_share_file_list(request_hash=request_hash, source_hash=source_hash, meta=data)

    with _share_cache_lock:
        if len(_share_files_cache) >= MAX_CACHE_SIZE:
            # Simple eviction strategy: clear the whole cache if it gets too big.
            # A more sophisticated LRU is possible but likely overkill for this scale.
            _share_files_cache.clear()
        _share_files_cache[request_hash] = (now, source_hash, files)

    return files


@app.route("/api/share/<share_hash>/files")
def list_share_files(share_hash: str):
    if not is_valid_share_hash(share_hash):
        return jsonify({"error": "Invalid share hash"}), 400

    source_hash = _resolve_share_hash(share_hash)

    force_refresh = parse_bool(request.args.get("refresh") or request.args.get("force"))
    max_age_param = request.args.get("max_age") or request.args.get("maxAge")
    max_age_seconds = DEFAULT_CACHE_TTL_SECONDS
    if max_age_param is not None:
        try:
            max_age_seconds = max(0, int(max_age_param))
        except (TypeError, ValueError):
            max_age_seconds = DEFAULT_CACHE_TTL_SECONDS

    files = _get_share_files(
        share_hash,
        source_hash=source_hash,
        force_refresh=force_refresh,
        max_age_seconds=max_age_seconds,
    )
    if files is None:
        return jsonify({"error": "Share not found"}), 404

    resp = jsonify(files)
    resp.headers["Cache-Control"] = "no-store"
    _log_event("gallery_view", share_hash)
    return resp


@app.route("/api/share/<share_hash>/browse")
@app.route("/api/share/<share_hash>/browse/<path:subpath>")
def browse_share_folder(share_hash: str, subpath: str = ""):
    """Browse share with folder structure (non-flattened view)."""
    if not is_valid_share_hash(share_hash):
        return jsonify({"error": "Invalid share hash"}), 400

    source_hash = _resolve_share_hash(share_hash)

    # Sanitize subpath
    if subpath:
        subpath = _safe_rel_path(subpath)
        if subpath is None:
            return jsonify({"error": "Invalid path"}), 400

    # Fetch folder contents from FileBrowser.
    # For folder shares, `/api/public/share/<hash>` lists the *parent* directory; default into the
    # actual shared folder entry instead of showing siblings.
    if subpath:
        data = _fetch_public_share_json(source_hash, subpath="/" + subpath)
    else:
        meta = _fetch_public_share_json(source_hash)
        if not meta:
            data = None
        else:
            entry_subpath = _infer_folder_share_entry_subpath(meta)
            data = _fetch_public_share_json(source_hash, subpath=entry_subpath) if entry_subpath else meta
    if not data:
        return jsonify({"error": "Share or path not found"}), 404

    # Check if it's a folder
    if not isinstance(data.get("items"), list):
        # It's a single file, not a folder
        return jsonify({"error": "Path is not a folder"}), 400

    result = _build_folder_structure(
        request_hash=share_hash,
        source_hash=source_hash,
        root=data,
        subpath=subpath,
    )

    resp = jsonify(result)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/share/<share_hash>/file/<path:filename>")
def serve_file(share_hash: str, filename: str):
    if not is_valid_share_hash(share_hash):
        return "Invalid share hash", 400

    source_hash = _resolve_share_hash(share_hash)

    filename = filename or ""
    safe = _safe_rel_path(filename)
    if not safe:
        return "Invalid filename", 400

    is_download = parse_bool(request.args.get("download") or request.args.get("dl"))
    if is_download:
        _log_event("file_download", share_hash, file_path=safe)

    encoded = quote(safe, safe="/")
    if is_download:
        return redirect(f"/api/public/dl/{source_hash}/{encoded}?download=1", code=302)
    return redirect(f"/api/public/dl/{source_hash}/{encoded}?inline=true", code=302)


CACHE_DIR = os.environ.get("DROPPR_CACHE_DIR", "/tmp/thumbnails")
os.makedirs(CACHE_DIR, exist_ok=True)

THUMB_MAX_WIDTH = int(os.environ.get("DROPPR_THUMB_MAX_WIDTH", "800"))
THUMB_JPEG_QUALITY = int(os.environ.get("DROPPR_THUMB_JPEG_QUALITY", "6"))
THUMB_FFMPEG_TIMEOUT_SECONDS = int(os.environ.get("DROPPR_THUMB_FFMPEG_TIMEOUT_SECONDS", "25"))
THUMB_MAX_CONCURRENCY = int(os.environ.get("DROPPR_THUMB_MAX_CONCURRENCY", "2"))
_thumb_sema = threading.BoundedSemaphore(max(1, THUMB_MAX_CONCURRENCY))

PROXY_CACHE_DIR = os.environ.get("DROPPR_PROXY_CACHE_DIR", "/tmp/proxy-cache")
os.makedirs(PROXY_CACHE_DIR, exist_ok=True)

STORAGE_CLEAR_MIN_AGE_SECONDS = int(os.environ.get("DROPPR_STORAGE_CLEAR_MIN_AGE_SECONDS", "300"))

PROXY_MAX_CONCURRENCY = int(os.environ.get("DROPPR_PROXY_MAX_CONCURRENCY", "1"))
_proxy_sema = threading.BoundedSemaphore(max(1, PROXY_MAX_CONCURRENCY))

_background_lock = threading.Lock()
_background_tasks: set[str] = set()

PROXY_MAX_DIMENSION = int(os.environ.get("DROPPR_PROXY_MAX_DIMENSION", "1280"))
PROXY_H264_PRESET = os.environ.get("DROPPR_PROXY_H264_PRESET", "veryfast")
PROXY_CRF = int(os.environ.get("DROPPR_PROXY_CRF", "28"))
PROXY_AAC_BITRATE = os.environ.get("DROPPR_PROXY_AAC_BITRATE", "128k")
PROXY_FFMPEG_TIMEOUT_SECONDS = int(os.environ.get("DROPPR_PROXY_FFMPEG_TIMEOUT_SECONDS", "900"))
PROXY_PROFILE_VERSION = os.environ.get("DROPPR_PROXY_PROFILE_VERSION", "1")

HD_MAX_CONCURRENCY = int(os.environ.get("DROPPR_HD_MAX_CONCURRENCY", "1"))
_hd_sema = threading.BoundedSemaphore(max(1, HD_MAX_CONCURRENCY))

HD_MAX_DIMENSION = int(os.environ.get("DROPPR_HD_MAX_DIMENSION", "0"))
HD_H264_PRESET = os.environ.get("DROPPR_HD_H264_PRESET", "veryfast")
HD_CRF = int(os.environ.get("DROPPR_HD_CRF", "20"))
HD_AAC_BITRATE = os.environ.get("DROPPR_HD_AAC_BITRATE", "192k")
HD_FFMPEG_TIMEOUT_SECONDS = int(os.environ.get("DROPPR_HD_FFMPEG_TIMEOUT_SECONDS", "1800"))
HD_PROFILE_VERSION = os.environ.get("DROPPR_HD_PROFILE_VERSION", "1")

def _get_cache_path(share_hash: str, filename: str) -> str:
    # Create a safe unique filename for the cache
    unique_str = f"{share_hash}:{filename}"
    hashed_name = hashlib.sha256(unique_str.encode()).hexdigest()
    return os.path.join(CACHE_DIR, f"{hashed_name}.jpg")


def _ffmpeg_thumbnail_cmd(*, src_url: str, dst_path: str, seek_seconds: int | None) -> list[str]:
    cmd = ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1"]
    if seek_seconds is not None:
        cmd += ["-ss", str(seek_seconds)]
    cmd += [
        "-i",
        src_url,
        "-vframes",
        "1",
        "-vf",
        f"scale='min({THUMB_MAX_WIDTH},iw)':-2",
        "-q:v",
        str(THUMB_JPEG_QUALITY),
        "-f",
        "image2",
        "-update",
        "1",
        "-y",
        dst_path,
    ]
    return cmd


def _proxy_cache_key(*, share_hash: str, file_path: str, size: int, modified: str | None = None) -> str:
    # Cache key is stable across requests and invalidates when the source changes or encoding profile changes.
    mod = (modified or "").strip()
    key = f"proxy:{PROXY_PROFILE_VERSION}:{PROXY_MAX_DIMENSION}:{PROXY_CRF}:{PROXY_H264_PRESET}:{share_hash}:{file_path}:{size}:{mod}"
    return hashlib.sha256(key.encode()).hexdigest()


def _hd_cache_key(*, share_hash: str, file_path: str, size: int, modified: str | None = None) -> str:
    mod = (modified or "").strip()
    key = f"hd:{HD_PROFILE_VERSION}:{HD_MAX_DIMENSION}:{HD_CRF}:{HD_H264_PRESET}:{share_hash}:{file_path}:{size}:{mod}"
    return hashlib.sha256(key.encode()).hexdigest()


def _ffmpeg_proxy_cmd(*, src_url: str, dst_path: str) -> list[str]:
    # Cap the longer side to PROXY_MAX_DIMENSION while preserving aspect ratio.
    scale = (
        f"scale='if(gt(iw,ih),min({PROXY_MAX_DIMENSION},iw),-2)':'if(gt(iw,ih),-2,min({PROXY_MAX_DIMENSION},ih))'"
    )
    return [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        src_url,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-sn",
        "-vf",
        scale,
        "-c:v",
        "libx264",
        "-preset",
        PROXY_H264_PRESET,
        "-crf",
        str(PROXY_CRF),
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "main",
        "-g",
        "60",
        "-keyint_min",
        "60",
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        str(PROXY_AAC_BITRATE),
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        dst_path,
    ]


def _ensure_fast_proxy_mp4(
    *,
    share_hash: str,
    file_path: str,
    size: int,
    modified: str | None = None,
) -> tuple[str, str, str, int | None]:
    cache_key = _proxy_cache_key(share_hash=share_hash, file_path=file_path, size=size, modified=modified)
    output_path = os.path.join(PROXY_CACHE_DIR, f"{cache_key}.mp4")
    public_url = f"/api/proxy-cache/{cache_key}.mp4"

    if os.path.exists(output_path):
        return cache_key, output_path, public_url, os.path.getsize(output_path)

    lock_path = output_path + ".lock"
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)

        if os.path.exists(output_path):
            return cache_key, output_path, public_url, os.path.getsize(output_path)

        tmp_path = output_path + ".tmp"
        try:
            os.remove(tmp_path)
        except FileNotFoundError:
            pass

        src_url = f"{FILEBROWSER_PUBLIC_DL_API}/{share_hash}/{quote(file_path, safe='/')}?inline=true"

        with _proxy_sema:
            cmd = _ffmpeg_proxy_cmd(src_url=src_url, dst_path=tmp_path)
            result = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=PROXY_FFMPEG_TIMEOUT_SECONDS,
            )

        if result.returncode != 0:
            app.logger.error(
                "ffmpeg proxy failed for %s: %s",
                file_path,
                result.stderr.decode(errors="replace"),
            )
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            raise RuntimeError("Proxy generation failed")

        os.replace(tmp_path, output_path)
        return cache_key, output_path, public_url, os.path.getsize(output_path)


def _ffmpeg_hd_remux_cmd(*, src_url: str, dst_path: str) -> list[str]:
    return [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        src_url,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-sn",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        dst_path,
    ]


def _ffmpeg_hd_copy_video_cmd(*, src_url: str, dst_path: str) -> list[str]:
    return [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        src_url,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-sn",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        str(HD_AAC_BITRATE),
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        dst_path,
    ]


def _ffmpeg_hd_transcode_cmd(*, src_url: str, dst_path: str) -> list[str]:
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        src_url,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-sn",
    ]

    if HD_MAX_DIMENSION and HD_MAX_DIMENSION > 0:
        scale = (
            f"scale='if(gt(iw,ih),min({HD_MAX_DIMENSION},iw),-2)':'if(gt(iw,ih),-2,min({HD_MAX_DIMENSION},ih))'"
        )
        cmd += ["-vf", scale]

    cmd += [
        "-c:v",
        "libx264",
        "-preset",
        HD_H264_PRESET,
        "-crf",
        str(HD_CRF),
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-g",
        "60",
        "-keyint_min",
        "60",
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        str(HD_AAC_BITRATE),
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        dst_path,
    ]
    return cmd


def _ensure_hd_mp4(
    *,
    share_hash: str,
    file_path: str,
    size: int,
    modified: str | None = None,
) -> tuple[str, str, str, int | None]:
    cache_key = _hd_cache_key(share_hash=share_hash, file_path=file_path, size=size, modified=modified)
    output_path = os.path.join(PROXY_CACHE_DIR, f"{cache_key}.mp4")
    public_url = f"/api/proxy-cache/{cache_key}.mp4"

    if os.path.exists(output_path):
        return cache_key, output_path, public_url, os.path.getsize(output_path)

    lock_path = output_path + ".lock"
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)

        if os.path.exists(output_path):
            return cache_key, output_path, public_url, os.path.getsize(output_path)

        tmp_path = output_path + ".tmp"
        try:
            os.remove(tmp_path)
        except FileNotFoundError:
            pass

        src_url = f"{FILEBROWSER_PUBLIC_DL_API}/{share_hash}/{quote(file_path, safe='/')}?inline=true"

        attempts = [
            ("remux", _ffmpeg_hd_remux_cmd(src_url=src_url, dst_path=tmp_path)),
            ("copy_video", _ffmpeg_hd_copy_video_cmd(src_url=src_url, dst_path=tmp_path)),
            ("transcode", _ffmpeg_hd_transcode_cmd(src_url=src_url, dst_path=tmp_path)),
        ]

        last_err = None
        with _hd_sema:
            for label, cmd in attempts:
                try:
                    result = subprocess.run(
                        cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=HD_FFMPEG_TIMEOUT_SECONDS,
                    )
                except subprocess.TimeoutExpired:
                    last_err = f"{label}: timeout"
                    continue

                if result.returncode == 0:
                    os.replace(tmp_path, output_path)
                    return cache_key, output_path, public_url, os.path.getsize(output_path)

                last_err = f"{label}: {result.stderr.decode(errors='replace')}"
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

        if last_err:
            app.logger.error("ffmpeg hd failed for %s: %s", file_path, last_err)
        raise RuntimeError("HD generation failed")


def _spawn_background(task_id: str, fn, *args, **kwargs) -> bool:
    with _background_lock:
        if task_id in _background_tasks:
            return False
        _background_tasks.add(task_id)

    def runner():
        try:
            fn(*args, **kwargs)
        except Exception as e:
            app.logger.warning("background task %s failed: %s", task_id, e)
        finally:
            with _background_lock:
                _background_tasks.discard(task_id)

    t = threading.Thread(target=runner, daemon=True)
    t.start()
    return True


@app.route("/api/share/<share_hash>/preview/<path:filename>")
def serve_preview(share_hash: str, filename: str):
    if not is_valid_share_hash(share_hash):
        return "Invalid share hash", 400

    source_hash = _resolve_share_hash(share_hash)

    filename = filename or ""
    safe = _safe_rel_path(filename)
    if not safe:
        return "Invalid filename", 400

    ext = os.path.splitext(safe)[1].lstrip(".").lower()
    is_video = ext in VIDEO_EXTS
    is_image = ext in IMAGE_EXTS
    if not is_video and not is_image:
        return "Unsupported preview type", 415

    cache_path = _get_cache_path(source_hash, safe)
    lock_path = cache_path + ".lock"

    # Check cache first (fast path)
    if os.path.exists(cache_path):
        try:
            # Touch the file to update access time (optional)
            os.utime(cache_path, None)
        except OSError:
            pass
        with open(cache_path, "rb") as f:
            return Response(f.read(), mimetype="image/jpeg")

    # Serialize generation for this specific file
    try:
        with open(lock_path, "w") as lock_file:
            # Acquire exclusive lock (blocking)
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            try:
                # Double-check cache after acquiring lock
                if os.path.exists(cache_path):
                    with open(cache_path, "rb") as f:
                        return Response(f.read(), mimetype="image/jpeg")

                # Generate thumbnail
                src_url = f"{FILEBROWSER_PUBLIC_DL_API}/{source_hash}/{quote(safe, safe='/')}?inline=true"

                with _thumb_sema:
                    cmd = _ffmpeg_thumbnail_cmd(
                        src_url=src_url, dst_path=cache_path, seek_seconds=(1 if is_video else None)
                    )
                    result = subprocess.run(
                        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=THUMB_FFMPEG_TIMEOUT_SECONDS
                    )

                    if result.returncode != 0 and is_video:
                        # Fallback: try capturing frame 0
                        cmd = _ffmpeg_thumbnail_cmd(src_url=src_url, dst_path=cache_path, seek_seconds=0)
                        result = subprocess.run(
                            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=THUMB_FFMPEG_TIMEOUT_SECONDS
                        )

                if result.returncode != 0:
                    app.logger.error("ffmpeg failed for %s: %s", safe, result.stderr.decode(errors="replace"))
                    return "Thumbnail generation failed", 500

                if os.path.exists(cache_path):
                    with open(cache_path, "rb") as f:
                        return Response(f.read(), mimetype="image/jpeg")
                else:
                    return "Thumbnail not generated", 500

            finally:
                # Release lock
                fcntl.flock(lock_file, fcntl.LOCK_UN)
    except subprocess.TimeoutExpired:
        app.logger.error("ffmpeg timed out for %s", safe)
        return "Thumbnail generation timed out", 504
    except Exception as e:
        app.logger.error("Error generating thumbnail for %s: %s", safe, e)
        return "Internal Error", 500


@app.route("/api/share/<share_hash>/proxy/<path:filename>")
def serve_proxy(share_hash: str, filename: str):
    if not is_valid_share_hash(share_hash):
        return "Invalid share hash", 400

    source_hash = _resolve_share_hash(share_hash)

    filename = filename or ""
    safe = _safe_rel_path(filename)
    if not safe:
        return "Invalid filename", 400

    ext = os.path.splitext(safe)[1].lstrip(".").lower()
    if ext not in VIDEO_EXTS:
        return "Unsupported proxy type", 415

    meta = _fetch_public_share_json(source_hash, subpath="/" + safe)
    if not meta:
        return "File not found", 404
    if isinstance(meta.get("items"), list) or parse_bool(meta.get("isDir")):
        return "File not found", 404

    name = meta.get("name") if isinstance(meta.get("name"), str) else None
    meta_path = meta.get("path") if isinstance(meta.get("path"), str) else None
    # For single-file shares, FileBrowser ignores the subpath. Enforce name match.
    if (not meta_path or not meta_path.startswith("/")) and name and safe != name:
        return "File not found", 404

    size = int(meta.get("size") or 0)
    modified = meta.get("modified") if isinstance(meta.get("modified"), str) else None

    try:
        _, _, public_url, _ = _ensure_fast_proxy_mp4(
            share_hash=source_hash, file_path=safe, size=size, modified=modified
        )
        return redirect(public_url, code=302)
    except subprocess.TimeoutExpired:
        app.logger.error("ffmpeg proxy timed out for %s", safe)
        return "Proxy generation timed out", 504
    except RuntimeError:
        return "Proxy generation failed", 500
    except Exception as e:
        app.logger.error("Error generating proxy for %s: %s", safe, e)
        return "Internal Error", 500


@app.route("/api/share/<share_hash>/video-sources/<path:filename>", methods=["GET", "POST"])
def video_sources(share_hash: str, filename: str):
    if not is_valid_share_hash(share_hash):
        return jsonify({"error": "Invalid share hash"}), 400

    source_hash = _resolve_share_hash(share_hash)

    filename = filename or ""
    safe = _safe_rel_path(filename)
    if not safe:
        return jsonify({"error": "Invalid filename"}), 400

    ext = os.path.splitext(safe)[1].lstrip(".").lower()
    if ext not in VIDEO_EXTS:
        return jsonify({"error": "Unsupported video type"}), 415

    meta = _fetch_public_share_json(source_hash, subpath="/" + safe)
    if not meta or isinstance(meta.get("items"), list) or parse_bool(meta.get("isDir")):
        return jsonify({"error": "File not found"}), 404

    name = meta.get("name") if isinstance(meta.get("name"), str) else None
    meta_path = meta.get("path") if isinstance(meta.get("path"), str) else None
    if (not meta_path or not meta_path.startswith("/")) and name and safe != name:
        return jsonify({"error": "File not found"}), 404

    original_size = int(meta.get("size") or 0)
    modified = meta.get("modified") if isinstance(meta.get("modified"), str) else None

    if meta_path and meta_path.startswith("/"):
        original_url = f"/api/public/dl/{source_hash}/{quote(safe, safe='/')}?inline=true"
    else:
        original_url = f"/api/public/file/{source_hash}?inline=true"

    proxy_key = _proxy_cache_key(share_hash=source_hash, file_path=safe, size=original_size, modified=modified)
    proxy_path = os.path.join(PROXY_CACHE_DIR, f"{proxy_key}.mp4")
    proxy_url = f"/api/proxy-cache/{proxy_key}.mp4"

    proxy_ready = os.path.exists(proxy_path)
    proxy_size = os.path.getsize(proxy_path) if proxy_ready else None

    hd_key = _hd_cache_key(share_hash=source_hash, file_path=safe, size=original_size, modified=modified)
    hd_path = os.path.join(PROXY_CACHE_DIR, f"{hd_key}.mp4")
    hd_url = f"/api/proxy-cache/{hd_key}.mp4"
    hd_ready = os.path.exists(hd_path)
    hd_size = os.path.getsize(hd_path) if hd_ready else None

    prepare_targets: set[str] = set()
    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        raw_targets = payload.get("prepare") or payload.get("targets") or payload.get("target")
        if raw_targets is None:
            raw_targets = request.args.get("prepare") or request.args.get("targets")
    else:
        raw_targets = request.args.get("prepare") or request.args.get("targets")

    if raw_targets is not None:
        if isinstance(raw_targets, str):
            prepare_targets = {p.strip().lower() for p in raw_targets.split(",") if p.strip()}
        elif isinstance(raw_targets, list):
            prepare_targets = {
                str(p).strip().lower() for p in raw_targets if p is not None and str(p).strip()
            }

    if request.method == "POST" and not prepare_targets:
        prepare_targets = {"hd"}

    prepare_started = {"fast": False, "hd": False}
    if "fast" in prepare_targets and not proxy_ready:
        prepare_started["fast"] = _spawn_background(
            f"fast:{proxy_key}",
            _ensure_fast_proxy_mp4,
            share_hash=source_hash,
            file_path=safe,
            size=original_size,
            modified=modified,
        )

    if "hd" in prepare_targets and not hd_ready:
        prepare_started["hd"] = _spawn_background(
            f"hd:{hd_key}",
            _ensure_hd_mp4,
            share_hash=source_hash,
            file_path=safe,
            size=original_size,
            modified=modified,
        )

    resp = jsonify(
        {
            "share": share_hash,
            "path": safe,
            "original": {
                "url": original_url,
                "size": original_size or None,
            },
            "fast": {
                "url": proxy_url,
                "ready": proxy_ready,
                "size": proxy_size,
            },
            "hd": {
                "url": hd_url,
                "ready": hd_ready,
                "size": hd_size,
            },
            "prepare": {
                "requested": sorted(prepare_targets) if prepare_targets else [],
                "started": prepare_started,
            },
        }
    )
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/share/<share_hash>/video-meta/<path:filename>")
def share_video_meta(share_hash: str, filename: str):
    if not is_valid_share_hash(share_hash):
        return jsonify({"error": "Invalid share hash"}), 400

    source_hash = _resolve_share_hash(share_hash)

    filename = filename or ""
    safe = _safe_rel_path(filename)
    if not safe:
        return jsonify({"error": "Invalid filename"}), 400

    ext = os.path.splitext(safe)[1].lstrip(".").lower()
    if ext not in VIDEO_EXTS:
        return jsonify({"error": "Unsupported video type"}), 415

    meta = _fetch_public_share_json(source_hash, subpath="/" + safe)
    if not meta or isinstance(meta.get("items"), list) or parse_bool(meta.get("isDir")):
        return jsonify({"error": "File not found"}), 404

    name = meta.get("name") if isinstance(meta.get("name"), str) else None
    meta_path = meta.get("path") if isinstance(meta.get("path"), str) else None
    if (not meta_path or not meta_path.startswith("/")) and name and safe != name:
        return jsonify({"error": "File not found"}), 404

    current_size = int(meta.get("size") or 0) or None
    current_modified = meta.get("modified") if isinstance(meta.get("modified"), str) else None

    db_path = "/" + safe.lstrip("/")
    row = None
    try:
        with _video_meta_conn() as conn:
            row = conn.execute(
                """
                SELECT
                    path,
                    status,
                    action,
                    error,
                    uploaded_at,
                    processed_at,
                    original_size,
                    processed_size,
                    original_meta_json,
                    processed_meta_json
                FROM video_meta
                WHERE path = ?
                LIMIT 1
                """,
                (db_path,),
            ).fetchone()
    except Exception as e:
        app.logger.error("Failed to read video meta for %s: %s", db_path, e)
        return jsonify({"error": "Failed to read video metadata"}), 500

    if not row:
        resp = jsonify(
            {
                "share": share_hash,
                "path": safe,
                "name": name or os.path.basename(safe),
                "current": {"size": current_size, "modified": current_modified},
                "recorded": False,
            }
        )
        resp.headers["Cache-Control"] = "no-store"
        return resp

    original_meta = None
    processed_meta = None
    try:
        if row["original_meta_json"]:
            original_meta = json.loads(row["original_meta_json"])
    except Exception:
        original_meta = None

    try:
        if row["processed_meta_json"]:
            processed_meta = json.loads(row["processed_meta_json"])
    except Exception:
        processed_meta = None

    resp = jsonify(
        {
            "share": share_hash,
            "path": safe,
            "name": name or os.path.basename(safe),
            "current": {"size": current_size, "modified": current_modified},
            "recorded": True,
            "status": str(row["status"]),
            "action": (str(row["action"]) if row["action"] is not None else None),
            "error": (str(row["error"]) if row["error"] is not None else None),
            "uploaded_at": int(row["uploaded_at"] or 0) if row["uploaded_at"] else None,
            "processed_at": int(row["processed_at"] or 0) if row["processed_at"] else None,
            "original_size": int(row["original_size"] or 0) if row["original_size"] else None,
            "processed_size": int(row["processed_size"] or 0) if row["processed_size"] else None,
            "original": original_meta,
            "processed": processed_meta,
        }
    )
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/share/<share_hash>/download")
def download_all(share_hash: str):
    if not is_valid_share_hash(share_hash):
        return "Invalid share hash", 400

    source_hash = _resolve_share_hash(share_hash)

    # Check if this is a single-file share (video/image) that needs range request support
    # Mobile browsers require range requests for video playback
    data = _fetch_public_share_json(source_hash)
    if data and not isinstance(data.get("items"), list):
        # Single-file share - redirect to FileBrowser endpoint which supports range requests
        # This is critical for mobile video playback
        _log_event("file_download", share_hash)
        inline = request.args.get("inline") or request.args.get("play")
        if inline:
            return redirect(f"/api/public/file/{source_hash}?inline=true", code=302)
        return redirect(f"/api/public/file/{source_hash}", code=302)

    # Folder share - stream ZIP through proxy (no range support needed for ZIP downloads)
    try:
        req_url = f"{FILEBROWSER_PUBLIC_DL_API}/{source_hash}?download=1"
        req = requests.get(req_url, stream=True, timeout=120)
        req.raise_for_status()
        _log_event("zip_download", share_hash)

        headers = {}
        content_disposition = req.headers.get("Content-Disposition")
        if content_disposition:
            headers["Content-Disposition"] = content_disposition
        else:
            headers["Content-Disposition"] = f'attachment; filename="share_{share_hash}.zip"'

        return Response(
            stream_with_context(req.iter_content(chunk_size=8192)),
            status=req.status_code,
            content_type=req.headers.get("Content-Type"),
            headers=headers,
        )
    except Exception as e:
        app.logger.error("Failed to download share for %s: %s", share_hash, e)
        return "Failed to download share", 500


@app.route("/api/droppr/shares/<share_hash>/expire", methods=["POST"])
def droppr_update_share_expire(share_hash: str):
    if not is_valid_share_hash(share_hash):
        return jsonify({"error": "Invalid share hash"}), 400

    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        status = _validate_filebrowser_admin(token)
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502

    if status is not None:
        return jsonify({"error": "Unauthorized"}), status

    payload = request.get_json(silent=True) or {}
    hours_raw = payload.get("hours")
    if hours_raw is None:
        hours_raw = payload.get("expires_hours") or payload.get("expiresHours")
    if hours_raw is None:
        return jsonify({"error": "Missing hours"}), 400

    try:
        hours = int(str(hours_raw).strip() or "0")
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid hours"}), 400

    max_hours = 24 * 365 * 10
    if hours < 0 or hours > max_hours:
        return jsonify({"error": f"Hours must be between 0 and {max_hours}"}), 400

    try:
        path = payload.get("path")
        if not isinstance(path, str) or not path.strip():
            source_hash = _resolve_share_hash(share_hash)
            meta = _fetch_public_share_json(source_hash)
            path = meta.get("path") if isinstance(meta, dict) else None

        if not isinstance(path, str) or not path.strip():
            return jsonify({"error": "Missing share path"}), 400

        path_encoded = _encode_share_path(path)
        if not path_encoded:
            return jsonify({"error": "Invalid share path"}), 400

        new_share = _create_filebrowser_share(token=token, path_encoded=path_encoded, hours=hours)
        new_hash = new_share.get("hash")
        new_expire = new_share.get("expire")
        if not is_valid_share_hash(new_hash):
            raise RuntimeError("Share API returned invalid hash")

        target_expire = int(new_expire or 0) if new_expire is not None else None
        _upsert_share_alias(from_hash=share_hash, to_hash=new_hash, path=path, target_expire=target_expire)

        with _share_cache_lock:
            _share_files_cache.pop(share_hash, None)

        result = {
            "hash": share_hash,
            "target_hash": new_hash,
            "path": path,
            "target_expire": target_expire,
            "hours": hours,
        }
    except Exception as e:
        app.logger.error("Failed to update share expiration for %s: %s", share_hash, e)
        return jsonify({"error": "Failed to update share expiration"}), 500

    resp = jsonify(result)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/droppr/shares/aliases")
def droppr_list_share_aliases():
    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        status = _validate_filebrowser_admin(token)
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502

    if status is not None:
        return jsonify({"error": "Unauthorized"}), status

    limit = _parse_int(request.args.get("limit")) or 500
    try:
        aliases = _list_share_aliases(limit=limit)
    except Exception as e:
        app.logger.error("Failed to list share aliases: %s", e)
        return jsonify({"error": "Failed to list share aliases"}), 500

    resp = jsonify({"aliases": aliases})
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/droppr/video-meta")
def droppr_video_meta():
    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        status = _validate_filebrowser_admin(token)
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502

    if status is not None:
        return jsonify({"error": "Unauthorized"}), status

    raw_path = request.args.get("path") or request.args.get("p")
    safe_path = _safe_root_path(raw_path)
    if not safe_path or safe_path == "/":
        return jsonify({"error": "Missing or invalid path"}), 400

    try:
        with _video_meta_conn() as conn:
            row = conn.execute(
                """
                SELECT
                    path,
                    status,
                    action,
                    error,
                    uploaded_at,
                    processed_at,
                    original_size,
                    processed_size,
                    original_meta_json,
                    processed_meta_json
                FROM video_meta
                WHERE path = ?
                LIMIT 1
                """,
                (safe_path,),
            ).fetchone()
    except Exception as e:
        app.logger.error("Failed to read video meta for %s: %s", safe_path, e)
        return jsonify({"error": "Failed to read video metadata"}), 500

    if not row:
        return jsonify({"error": "Not found"}), 404

    original_meta = None
    processed_meta = None
    try:
        if row["original_meta_json"]:
            original_meta = json.loads(row["original_meta_json"])
    except Exception:
        original_meta = None

    try:
        if row["processed_meta_json"]:
            processed_meta = json.loads(row["processed_meta_json"])
    except Exception:
        processed_meta = None

    resp = jsonify(
        {
            "path": str(row["path"]),
            "status": str(row["status"]),
            "action": (str(row["action"]) if row["action"] is not None else None),
            "error": (str(row["error"]) if row["error"] is not None else None),
            "uploaded_at": int(row["uploaded_at"] or 0) if row["uploaded_at"] else None,
            "processed_at": int(row["processed_at"] or 0) if row["processed_at"] else None,
            "original_size": int(row["original_size"] or 0) if row["original_size"] else None,
            "processed_size": int(row["processed_size"] or 0) if row["processed_size"] else None,
            "original": original_meta,
            "processed": processed_meta,
        }
    )
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/droppr/client-config")
def droppr_client_config():
    effective, _overrides = _get_effective_session_settings()
    resp = jsonify(
        {
            "session": {
                "admin_idle_minutes": int(effective["admin_idle_minutes"]),
                "user_idle_minutes": int(effective["user_idle_minutes"]),
                "admin_max_minutes": int(effective["admin_max_minutes"]),
                "user_max_minutes": int(effective["user_max_minutes"]),
                "warning_seconds": int(effective["warning_seconds"]),
            }
        }
    )
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/droppr/session-settings", methods=["GET", "POST"])
def droppr_session_settings():
    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        status = _validate_filebrowser_admin(token)
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502

    if status is not None:
        return jsonify({"error": "Unauthorized"}), status

    mapping = [
        ("admin_idle_minutes", SETTINGS_KEY_SESSION_ADMIN_IDLE_MINUTES, 0, 525600),
        ("user_idle_minutes", SETTINGS_KEY_SESSION_USER_IDLE_MINUTES, 0, 525600),
        ("admin_max_minutes", SETTINGS_KEY_SESSION_ADMIN_MAX_MINUTES, 0, 525600),
        ("user_max_minutes", SETTINGS_KEY_SESSION_USER_MAX_MINUTES, 0, 525600),
        ("warning_seconds", SETTINGS_KEY_SESSION_WARNING_SECONDS, 0, 3600),
    ]

    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        if parse_bool(payload.get("reset")):
            for _field, key, _min_v, _max_v in mapping:
                try:
                    _settings_delete(key)
                except Exception:
                    pass
        else:
            for field, key, min_v, max_v in mapping:
                if field not in payload:
                    continue
                raw = payload.get(field)
                if raw is None or (isinstance(raw, str) and not raw.strip()):
                    _settings_delete(key)
                    continue
                try:
                    v = int(str(raw).strip())
                except Exception:
                    return jsonify({"error": f"Invalid {field}"}), 400
                v = max(int(min_v), min(int(max_v), v))
                _settings_set_value(key, str(v))

    effective, overrides = _get_effective_session_settings()
    defaults = _get_default_session_settings()

    resp = jsonify(
        {
            "session": effective,
            "defaults": defaults,
            "overrides": overrides,
        }
    )
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _storage_cache_targets() -> dict[str, dict]:
    return {
        "thumbnails": {
            "key": "thumbnails",
            "label": "Thumbnails",
            "path": os.path.abspath(CACHE_DIR),
            "kind": "thumbnail",
        },
        "video_proxy": {
            "key": "video_proxy",
            "label": "Video proxy cache",
            "path": os.path.abspath(PROXY_CACHE_DIR),
            "kind": "video",
        },
    }


def _iter_cache_file_stats(root: str):
    root_abs = os.path.abspath(root)
    if not os.path.isdir(root_abs):
        return

    stack = [root_abs]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        yield entry.path, entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
        except OSError:
            continue


def _cache_dir_stats(target: dict) -> dict:
    path = str(target["path"])
    stats = {
        "key": target["key"],
        "label": target["label"],
        "kind": target["kind"],
        "path": path,
        "exists": os.path.isdir(path),
        "bytes": 0,
        "files": 0,
        "lock_files": 0,
        "oldest_mtime": None,
        "newest_mtime": None,
    }

    for file_path, st in _iter_cache_file_stats(path) or []:
        size = int(getattr(st, "st_size", 0) or 0)
        mtime = int(getattr(st, "st_mtime", 0) or 0)
        stats["files"] += 1
        stats["bytes"] += size
        if str(file_path).endswith(".lock"):
            stats["lock_files"] += 1
        if mtime:
            if stats["oldest_mtime"] is None or mtime < int(stats["oldest_mtime"]):
                stats["oldest_mtime"] = mtime
            if stats["newest_mtime"] is None or mtime > int(stats["newest_mtime"]):
                stats["newest_mtime"] = mtime

    return stats


def _storage_stats_payload() -> dict:
    targets = _storage_cache_targets()
    target_stats = {key: _cache_dir_stats(target) for key, target in targets.items()}
    total_cache_bytes = sum(int(v.get("bytes") or 0) for v in target_stats.values())
    total_cache_files = sum(int(v.get("files") or 0) for v in target_stats.values())

    disk_path = os.path.abspath(os.path.dirname(PROXY_CACHE_DIR) or PROXY_CACHE_DIR)
    if not os.path.exists(disk_path):
        disk_path = os.path.abspath(os.path.dirname(CACHE_DIR) or CACHE_DIR)
    if not os.path.exists(disk_path):
        disk_path = "/"

    usage = shutil.disk_usage(disk_path)
    return {
        "targets": target_stats,
        "total_cache_bytes": total_cache_bytes,
        "total_cache_files": total_cache_files,
        "disk": {
            "path": disk_path,
            "total": int(usage.total),
            "used": int(usage.used),
            "free": int(usage.free),
        },
        "clear_min_age_seconds": STORAGE_CLEAR_MIN_AGE_SECONDS,
    }


def _parse_storage_targets(payload: dict | None) -> list[str]:
    payload = payload if isinstance(payload, dict) else {}
    raw = payload.get("targets", payload.get("target"))
    if raw is None:
        raw = request.args.get("targets") or request.args.get("target") or "all"

    if isinstance(raw, str):
        values = [v.strip().lower() for v in raw.split(",") if v.strip()]
    elif isinstance(raw, list):
        values = [str(v).strip().lower() for v in raw if str(v).strip()]
    else:
        values = []

    aliases = {
        "all": "all",
        "thumb": "thumbnails",
        "thumbs": "thumbnails",
        "thumbnail": "thumbnails",
        "thumbnails": "thumbnails",
        "proxy": "video_proxy",
        "proxies": "video_proxy",
        "video": "video_proxy",
        "videos": "video_proxy",
        "video_proxy": "video_proxy",
        "video-proxy": "video_proxy",
    }
    normalized = []
    for value in values or ["all"]:
        mapped = aliases.get(value)
        if mapped is None:
            raise ValueError(f"Invalid storage target: {value}")
        if mapped == "all":
            return list(_storage_cache_targets().keys())
        if mapped not in normalized:
            normalized.append(mapped)
    return normalized or list(_storage_cache_targets().keys())


def _clear_cache_target(target: dict, *, min_age_seconds: int, dry_run: bool = False) -> dict:
    now = time.time()
    cutoff = now - max(0, min_age_seconds)
    out = {
        "key": target["key"],
        "label": target["label"],
        "path": target["path"],
        "dry_run": bool(dry_run),
        "deleted_files": 0,
        "deleted_bytes": 0,
        "skipped_recent": 0,
        "skipped_locks": 0,
        "errors": [],
    }

    for file_path, st in _iter_cache_file_stats(str(target["path"])) or []:
        if str(file_path).endswith(".lock"):
            out["skipped_locks"] += 1
            continue
        if float(getattr(st, "st_mtime", 0) or 0) > cutoff:
            out["skipped_recent"] += 1
            continue

        size = int(getattr(st, "st_size", 0) or 0)
        if not dry_run:
            try:
                os.unlink(file_path)
            except FileNotFoundError:
                continue
            except OSError as e:
                errors = out["errors"]
                if len(errors) < 20:
                    errors.append({"path": os.path.basename(file_path), "error": str(e)})
                continue

        out["deleted_files"] += 1
        out["deleted_bytes"] += size

    return out


@app.route("/api/droppr/storage", methods=["GET"])
def droppr_storage_stats():
    auth_error = _admin_auth_error_response()
    if auth_error is not None:
        return auth_error

    resp = jsonify({"storage": _storage_stats_payload()})
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/droppr/storage/clear", methods=["POST"])
def droppr_storage_clear():
    auth_error = _admin_auth_error_response()
    if auth_error is not None:
        return auth_error

    payload = request.get_json(silent=True) or {}
    try:
        target_keys = _parse_storage_targets(payload)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    min_age_seconds = _parse_non_negative_int(
        payload.get("min_age_seconds", request.args.get("min_age_seconds", STORAGE_CLEAR_MIN_AGE_SECONDS)),
        default=STORAGE_CLEAR_MIN_AGE_SECONDS,
        max_value=86400,
    )
    dry_run = parse_bool(payload.get("dry_run") if "dry_run" in payload else request.args.get("dry_run"))
    targets = _storage_cache_targets()
    results = [
        _clear_cache_target(targets[key], min_age_seconds=min_age_seconds, dry_run=dry_run)
        for key in target_keys
    ]

    resp = jsonify(
        {
            "ok": True,
            "dry_run": dry_run,
            "min_age_seconds": min_age_seconds,
            "results": results,
            "storage": _storage_stats_payload(),
        }
    )
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/analytics/config")
def analytics_config():
    if not ANALYTICS_ENABLED:
        return jsonify({"error": "Analytics disabled"}), 404

    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        _fetch_filebrowser_shares(token)
    except PermissionError:
        return jsonify({"error": "Unauthorized"}), 401
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502

    return jsonify(
        {
            "enabled": ANALYTICS_ENABLED,
            "retention_days": ANALYTICS_RETENTION_DAYS,
            "ip_mode": ANALYTICS_IP_MODE,
            "log_gallery_views": ANALYTICS_LOG_GALLERY_VIEWS,
            "log_file_downloads": ANALYTICS_LOG_FILE_DOWNLOADS,
            "log_zip_downloads": ANALYTICS_LOG_ZIP_DOWNLOADS,
        }
    )


@app.route("/api/analytics/shares")
def analytics_shares():
    if not ANALYTICS_ENABLED:
        return jsonify({"error": "Analytics disabled"}), 404

    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        filebrowser_shares = _fetch_filebrowser_shares(token)
    except PermissionError:
        return jsonify({"error": "Unauthorized"}), 401
    except Exception as e:
        return jsonify({"error": f"Failed to fetch FileBrowser shares: {e}"}), 502

    include_empty = parse_bool(request.args.get("include_empty") or request.args.get("includeEmpty") or "true")
    since, until = _get_time_range()

    stats_by_hash: dict[str, dict] = {}
    total_unique_ips = 0
    with _analytics_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                share_hash,
                SUM(CASE WHEN event_type = 'gallery_view' THEN 1 ELSE 0 END) AS gallery_views,
                SUM(CASE WHEN event_type = 'file_download' THEN 1 ELSE 0 END) AS file_downloads,
                SUM(CASE WHEN event_type = 'zip_download' THEN 1 ELSE 0 END) AS zip_downloads,
                COUNT(DISTINCT CASE WHEN event_type IN ('file_download', 'zip_download') THEN ip END) AS unique_ips,
                MAX(created_at) AS last_seen,
                MAX(CASE WHEN event_type IN ('file_download', 'zip_download') THEN created_at ELSE NULL END) AS last_download_at
            FROM download_events
            WHERE created_at >= ? AND created_at <= ?
            GROUP BY share_hash
            """,
            (since, until),
        ).fetchall()

        for row in rows:
            stats_by_hash[str(row["share_hash"])] = {
                "gallery_views": int(row["gallery_views"] or 0),
                "file_downloads": int(row["file_downloads"] or 0),
                "zip_downloads": int(row["zip_downloads"] or 0),
                "downloads": int((row["file_downloads"] or 0) + (row["zip_downloads"] or 0)),
                "unique_ips": int(row["unique_ips"] or 0),
                "last_seen": int(row["last_seen"] or 0) if row["last_seen"] else None,
                "last_download_at": int(row["last_download_at"] or 0) if row["last_download_at"] else None,
            }

        total_unique_ips_row = conn.execute(
            """
            SELECT COUNT(DISTINCT ip) AS unique_ips
            FROM download_events
            WHERE created_at >= ? AND created_at <= ? AND ip IS NOT NULL AND event_type IN ('file_download', 'zip_download')
            """,
            (since, until),
        ).fetchone()
        if total_unique_ips_row is not None:
            total_unique_ips = int(total_unique_ips_row["unique_ips"] or 0)

    shares = []
    seen_hashes: set[str] = set()

    for share in filebrowser_shares:
        share_hash = share.get("hash")
        if not is_valid_share_hash(share_hash):
            continue
        seen_hashes.add(share_hash)
        stats = stats_by_hash.get(share_hash) or {
            "gallery_views": 0,
            "file_downloads": 0,
            "zip_downloads": 0,
            "downloads": 0,
            "unique_ips": 0,
            "last_seen": None,
            "last_download_at": None,
        }

        if not include_empty and stats["gallery_views"] == 0 and stats["downloads"] == 0:
            continue

        shares.append(
            {
                "hash": share_hash,
                "path": share.get("path"),
                "expire": share.get("expire"),
                "userID": share.get("userID"),
                "username": share.get("username"),
                "url": f"/gallery/{share_hash}",
                **stats,
            }
        )

    include_deleted = parse_bool(request.args.get("include_deleted") or request.args.get("includeDeleted") or "true")
    if include_deleted:
        for share_hash, stats in stats_by_hash.items():
            if share_hash in seen_hashes:
                continue
            if not include_empty and stats["gallery_views"] == 0 and stats["downloads"] == 0:
                continue
            shares.append(
                {
                    "hash": share_hash,
                    "path": None,
                    "expire": None,
                    "userID": None,
                    "username": None,
                    "url": f"/gallery/{share_hash}",
                    "deleted": True,
                    **stats,
                }
            )

    shares.sort(key=lambda s: (s.get("last_download_at") or 0, s.get("last_seen") or 0), reverse=True)

    totals = {
        "shares": len(shares),
        "gallery_views": sum(s["gallery_views"] for s in shares),
        "downloads": sum(s["downloads"] for s in shares),
        "file_downloads": sum(s["file_downloads"] for s in shares),
        "zip_downloads": sum(s["zip_downloads"] for s in shares),
        "unique_ips": total_unique_ips,
    }

    return jsonify({"range": {"since": since, "until": until}, "totals": totals, "shares": shares})


@app.route("/api/analytics/shares/<share_hash>")
def analytics_share_detail(share_hash: str):
    if not ANALYTICS_ENABLED:
        return jsonify({"error": "Analytics disabled"}), 404

    if not is_valid_share_hash(share_hash):
        return jsonify({"error": "Invalid share hash"}), 400

    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        filebrowser_shares = _fetch_filebrowser_shares(token)
    except PermissionError:
        return jsonify({"error": "Unauthorized"}), 401
    except Exception as e:
        return jsonify({"error": f"Failed to fetch FileBrowser shares: {e}"}), 502

    share_info = next((s for s in filebrowser_shares if s.get("hash") == share_hash), None)
    since, until = _get_time_range()

    counts: dict[str, int] = {}
    ips = []
    events = []

    with _analytics_conn() as conn:
        for row in conn.execute(
            """
            SELECT event_type, COUNT(*) AS count
            FROM download_events
            WHERE share_hash = ? AND created_at >= ? AND created_at <= ?
            GROUP BY event_type
            """,
            (share_hash, since, until),
        ).fetchall():
            counts[str(row["event_type"])] = int(row["count"] or 0)

        ips = [
            {
                "ip": row["ip"],
                "file_downloads": int(row["file_downloads"] or 0),
                "zip_downloads": int(row["zip_downloads"] or 0),
                "downloads": int((row["file_downloads"] or 0) + (row["zip_downloads"] or 0)),
                "last_seen": int(row["last_seen"] or 0) if row["last_seen"] else None,
            }
            for row in conn.execute(
                """
                SELECT
                    ip,
                    SUM(CASE WHEN event_type = 'file_download' THEN 1 ELSE 0 END) AS file_downloads,
                    SUM(CASE WHEN event_type = 'zip_download' THEN 1 ELSE 0 END) AS zip_downloads,
                    MAX(created_at) AS last_seen
                FROM download_events
                WHERE share_hash = ? AND created_at >= ? AND created_at <= ? AND ip IS NOT NULL AND event_type IN ('file_download', 'zip_download')
                GROUP BY ip
                ORDER BY (file_downloads + zip_downloads) DESC, last_seen DESC
                LIMIT 200
                """,
                (share_hash, since, until),
            ).fetchall()
        ]

        events = [
            {
                "event_type": row["event_type"],
                "file_path": row["file_path"],
                "ip": row["ip"],
                "user_agent": row["user_agent"],
                "created_at": int(row["created_at"] or 0),
            }
            for row in conn.execute(
                """
                SELECT event_type, file_path, ip, user_agent, created_at
                FROM download_events
                WHERE share_hash = ? AND created_at >= ? AND created_at <= ?
                ORDER BY created_at DESC
                LIMIT 200
                """,
                (share_hash, since, until),
            ).fetchall()
        ]

    return jsonify(
        {
            "range": {"since": since, "until": until},
            "share": {
                "hash": share_hash,
                "path": share_info.get("path") if isinstance(share_info, dict) else None,
                "expire": share_info.get("expire") if isinstance(share_info, dict) else None,
                "userID": share_info.get("userID") if isinstance(share_info, dict) else None,
                "username": share_info.get("username") if isinstance(share_info, dict) else None,
                "url": f"/gallery/{share_hash}",
            },
            "counts": counts,
            "ips": ips,
            "events": events,
        }
    )


@app.route("/api/analytics/shares/<share_hash>/export.csv")
def analytics_share_export_csv(share_hash: str):
    if not ANALYTICS_ENABLED:
        return "Analytics disabled", 404

    if not is_valid_share_hash(share_hash):
        return "Invalid share hash", 400

    token = _get_auth_token()
    if not token:
        return "Missing auth token", 401

    try:
        _fetch_filebrowser_shares(token)
    except PermissionError:
        return "Unauthorized", 401
    except Exception as e:
        return f"Failed to validate auth: {e}", 502

    since, until = _get_time_range()

    with _analytics_conn() as conn:
        rows = conn.execute(
            """
            SELECT event_type, file_path, ip, user_agent, referer, created_at
            FROM download_events
            WHERE share_hash = ? AND created_at >= ? AND created_at <= ?
            ORDER BY created_at DESC
            """,
            (share_hash, since, until),
        ).fetchall()

    def esc(value):
        if value is None:
            return ""
        value = str(value).replace('"', '""')
        if any(c in value for c in [",", "\n", "\r", '"']):
            return f"\"{value}\""
        return value

    lines = ["event_type,file_path,ip,user_agent,referer,created_at"]
    for row in rows:
        lines.append(
            ",".join(
                [
                    esc(row["event_type"]),
                    esc(row["file_path"]),
                    esc(row["ip"]),
                    esc(row["user_agent"]),
                    esc(row["referer"]),
                    esc(int(row["created_at"] or 0)),
                ]
            )
        )

    csv_data = "\n".join(lines) + "\n"
    return Response(
        csv_data,
        content_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="droppr-share-{share_hash}-analytics.csv"'},
    )


# ============ ROBUST SHARE API ENDPOINTS ============

@app.route("/api/robust-share/create", methods=["POST"])
def create_robust_share():
    """Create a new robust share for a file or folder."""
    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        status = _validate_filebrowser_admin(token)
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502

    if status is not None:
        return jsonify({"error": "Unauthorized"}), status

    payload = request.get_json(silent=True) or {}
    path = payload.get("path")
    title = payload.get("title", "")
    password = payload.get("password", "")
    raw_hours = payload.get("expires_hours")
    if raw_hours is None:
        raw_hours = payload.get("expiresHours") or payload.get("expires") or payload.get("hours")

    if not path or not isinstance(path, str):
        return jsonify({"error": "Missing path"}), 400

    safe_path = _safe_root_path(path)
    if not safe_path:
        return jsonify({"error": "Invalid path"}), 400

    # Check if path exists in FileBrowser
    resp = requests.get(
        f"{FILEBROWSER_BASE_URL}/api/resources{quote(safe_path, safe='/')}",
        headers={"X-Auth": token},
        timeout=30,
    )
    if resp.status_code == 404:
        return jsonify({"error": "Path not found"}), 404
    if resp.status_code != 200:
        return jsonify({"error": "Failed to access path"}), 502

    data = resp.json()
    is_dir = data.get("isDir", False)
    share_type = "folder" if is_dir else "file"

    title_sanitized = _sanitize_title(title)
    if not title_sanitized:
        title_sanitized = os.path.basename(safe_path.rstrip("/"))[:MAX_TITLE_LENGTH]

    # Generate unique share ID
    share_id = _generate_robust_share_id()
    now = int(time.time())

    # Hash password if provided
    if not isinstance(password, str):
        password = ""
    if password and len(password) > MAX_PASSWORD_LENGTH:
        return jsonify({"error": "Password too long"}), 400

    password_hash = _hash_password(password) if password else None

    hours = 0
    if raw_hours is not None:
        try:
            hours = int(str(raw_hours).strip() or "0")
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid expires_hours"}), 400

    max_hours = 24 * 365 * 10
    if hours < 0 or hours > max_hours:
        return jsonify({"error": f"expires_hours must be between 0 and {max_hours}"}), 400

    expires_at = (now + hours * 3600) if hours > 0 else None

    # Create share in database
    with _robust_shares_conn() as conn:
        conn.execute(
            """
            INSERT INTO robust_shares (share_id, source_path, share_type, title, password_hash, created_at, expires_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (share_id, safe_path, share_type, title_sanitized, password_hash, now, expires_at, "admin"),
        )

    # Scan and store files in background (for large folders)
    try:
        file_count, total_size = _scan_and_store_files(share_id, safe_path, share_type)
    except Exception as e:
        app.logger.warning("Failed to scan files for share %s: %s", share_id, e)
        file_count, total_size = 0, 0

    share_url = f"/share/{share_id}"

    return jsonify({
        "share_id": share_id,
        "share_url": share_url,
        "path": safe_path,
        "share_type": share_type,
        "title": title_sanitized,
        "password_protected": bool(password),
        "expires_at": expires_at,
        "file_count": file_count,
        "total_size": total_size,
    })


@app.route("/api/robust-shares")
def list_robust_shares():
    """List all robust shares (admin only)."""
    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        status = _validate_filebrowser_admin(token)
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502

    if status is not None:
        return jsonify({"error": "Unauthorized"}), status

    limit = _parse_int(request.args.get("limit")) or 100
    limit = max(1, min(limit, 1000))

    with _robust_shares_conn() as conn:
        rows = conn.execute(
            """
            SELECT share_id, source_path, share_type, title, password_hash,
                   total_size, file_count, created_at, expires_at, last_accessed_at, access_count
            FROM robust_shares
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    now = int(time.time())
    shares = [
        {
            "share_id": row["share_id"],
            "source_path": row["source_path"],
            "share_type": row["share_type"],
            "title": row["title"],
            "password_protected": bool(row["password_hash"]),
            "total_size": row["total_size"],
            "file_count": row["file_count"],
            "created_at": row["created_at"],
            "expires_at": int(row["expires_at"] or 0) if row["expires_at"] else None,
            "last_accessed_at": row["last_accessed_at"],
            "access_count": row["access_count"],
            "share_url": f"/share/{row['share_id']}",
            "status": (
                "expired"
                if (row["expires_at"] and int(row["expires_at"] or 0) > 0 and now >= int(row["expires_at"] or 0))
                else "active"
            ),
        }
        for row in rows
    ]

    return jsonify({"shares": shares, "count": len(shares)})


@app.route("/api/robust-share/<share_id>/refresh", methods=["POST"])
def refresh_robust_share(share_id: str):
    """Refresh the stored file index and totals for a robust share."""
    if not is_valid_robust_share_id(share_id):
        return jsonify({"error": "Invalid share ID"}), 400

    auth_error = _admin_auth_error_response()
    if auth_error is not None:
        return auth_error

    info = _get_robust_share_info(share_id)
    if not info:
        return jsonify({"error": "Share not found"}), 404

    source_path = str(info.get("source_path") or "")
    share_type = str(info.get("share_type") or "")
    fs_path = _robust_share_fs_path(source_path=source_path)
    if not fs_path:
        return jsonify({"error": "Invalid share source path"}), 400
    if share_type == "file":
        if not os.path.isfile(fs_path):
            return jsonify({"error": "Share source file not found"}), 404
    elif share_type == "folder":
        if not os.path.isdir(fs_path):
            return jsonify({"error": "Share source folder not found"}), 404
    else:
        return jsonify({"error": "Invalid share type"}), 400

    try:
        file_count, total_size = _scan_and_store_files(share_id, source_path, share_type)
    except Exception as e:
        app.logger.warning("Failed to refresh robust share %s: %s", share_id, e)
        return jsonify({"error": "Failed to refresh share files"}), 500

    refreshed = _get_robust_share_info(share_id) or info
    now = int(time.time())
    share = {
        "share_id": refreshed["share_id"],
        "source_path": refreshed["source_path"],
        "share_type": refreshed["share_type"],
        "title": refreshed["title"],
        "password_protected": bool(refreshed["password_protected"]),
        "total_size": int(total_size or 0),
        "file_count": int(file_count or 0),
        "created_at": refreshed["created_at"],
        "expires_at": refreshed.get("expires_at"),
        "last_accessed_at": refreshed.get("last_accessed_at"),
        "access_count": refreshed.get("access_count"),
        "share_url": f"/share/{share_id}",
        "status": "expired" if _robust_share_is_expired(refreshed, now=now) else "active",
        "refreshed_at": now,
    }

    resp = jsonify({"refreshed": True, "share": share})
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/robust-share/<share_id>", methods=["DELETE"])
def delete_robust_share(share_id: str):
    """Delete a robust share (admin only)."""
    if not is_valid_robust_share_id(share_id):
        return jsonify({"error": "Invalid share ID"}), 400

    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        status = _validate_filebrowser_admin(token)
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502

    if status is not None:
        return jsonify({"error": "Unauthorized"}), status

    with _robust_shares_conn() as conn:
        result = conn.execute("DELETE FROM robust_shares WHERE share_id = ?", (share_id,))
        if result.rowcount == 0:
            return jsonify({"error": "Share not found"}), 404

    return jsonify({"deleted": True, "share_id": share_id})


# ============ ROBUST SHARE PUBLIC ENDPOINTS ============

@app.route("/api/robust-share/<share_id>/info")
def robust_share_info(share_id: str):
    """Get share metadata (public, shows if password required)."""
    if not is_valid_robust_share_id(share_id):
        return jsonify({"error": "Invalid share ID"}), 400

    info = _get_robust_share_info(share_id)
    if not info:
        return jsonify({"error": "Share not found"}), 404

    if _robust_share_is_expired(info):
        return jsonify({"error": "Share expired"}), 410

    title = _robust_share_effective_title(info)

    # Return public info (without sensitive data)
    return jsonify({
        "share_id": info["share_id"],
        "title": title,
        "share_type": info["share_type"],
        "password_protected": info["password_protected"],
        "expires_at": info.get("expires_at"),
        "total_size": info["total_size"],
        "file_count": info["file_count"],
    })


@app.route("/api/robust-share/<share_id>/verify", methods=["POST"])
def verify_robust_share_password(share_id: str):
    """Verify password for protected shares."""
    if not is_valid_robust_share_id(share_id):
        return jsonify({"error": "Invalid share ID"}), 400

    # Rate limiting
    client_ip = _get_client_ip() or "unknown"
    rate_key = f"verify:{share_id}:{client_ip}"
    if not _check_rate_limit(rate_key, max_requests=5, window_seconds=60):
        return jsonify({"error": "Too many attempts. Please wait a minute."}), 429

    info = _get_robust_share_info(share_id)
    if not info:
        return jsonify({"error": "Share not found"}), 404

    if _robust_share_is_expired(info):
        return jsonify({"error": "Share expired"}), 410

    if not info["password_protected"]:
        return jsonify({"valid": True, "token": None})

    payload = request.get_json(silent=True) or {}
    password = payload.get("password", "")

    if not password:
        return jsonify({"error": "Password required"}), 400

    password_hash = _get_robust_share_password_hash(share_id)
    if not password_hash:
        return jsonify({"error": "Share configuration error"}), 500

    if not _verify_password(password, password_hash):
        return jsonify({"valid": False, "error": "Invalid password"}), 401

    # Create session token
    token = _create_session_token(share_id, client_ip)

    return jsonify({"valid": True, "token": token})


@app.route("/api/robust-share/<share_id>/files")
def robust_share_files(share_id: str):
    """List files in the share (requires password verification if protected)."""
    if not is_valid_robust_share_id(share_id):
        return jsonify({"error": "Invalid share ID"}), 400

    info = _get_robust_share_info(share_id)
    if not info:
        return jsonify({"error": "Share not found"}), 404

    if _robust_share_is_expired(info):
        return jsonify({"error": "Share expired"}), 410

    title = _robust_share_effective_title(info)

    # Check password protection
    if info["password_protected"]:
        token = request.headers.get("X-Session-Token") or request.args.get("token")
        if not _validate_session_token(token, share_id):
            return jsonify({"error": "Authentication required"}), 401

    # Update access stats
    _update_robust_share_access(share_id)

    files = _get_robust_share_files(share_id)

    # Build folder structure from flat file list
    folders = {}
    root_files = []

    for f in files:
        path = f["path"]
        if "/" in path:
            folder = path.split("/")[0]
            if folder not in folders:
                folders[folder] = {"name": folder, "files": [], "size": 0}
            folders[folder]["files"].append(f)
            folders[folder]["size"] += f["size"]
        else:
            root_files.append(f)

    return jsonify({
        "share_id": share_id,
        "title": title,
        "share_type": info["share_type"],
        "total_size": info["total_size"],
        "file_count": info["file_count"],
        "files": root_files,
        "folders": list(folders.values()),
        "all_files": files,
    })


@app.route("/api/robust-share/<share_id>/download/<path:filename>")
def robust_share_download_file(share_id: str, filename: str):
    """Download a single file with Range request support."""
    if not is_valid_robust_share_id(share_id):
        return "Invalid share ID", 400

    info = _get_robust_share_info(share_id)
    if not info:
        return "Share not found", 404

    if _robust_share_is_expired(info):
        return "Share expired", 410

    # Check password protection
    if info["password_protected"]:
        token = request.headers.get("X-Session-Token") or request.args.get("token")
        if not _validate_session_token(token, share_id):
            return "Authentication required", 401

    # Validate filename
    safe_filename = _safe_rel_path(filename)
    if not safe_filename:
        return "Invalid filename", 400

    # Get file info from database
    with _robust_shares_conn() as conn:
        row = conn.execute(
            "SELECT file_size FROM robust_share_files WHERE share_id = ? AND file_path = ? LIMIT 1",
            (share_id, safe_filename),
        ).fetchone()

    if not row:
        return "File not found", 404

    source_path = info["source_path"]
    if info["share_type"] == "file":
        fs_path = _robust_share_fs_path(source_path=source_path)
    else:
        fs_path = _robust_share_fs_path(source_path=source_path, rel_path=safe_filename)

    if not fs_path or not os.path.isfile(fs_path):
        return "File not found", 404

    try:
        st = os.stat(fs_path)
        size = int(st.st_size)
    except Exception:
        size = int(row["file_size"] or 0)

    basename = os.path.basename(safe_filename)
    content_type = mimetypes.guess_type(basename)[0] or "application/octet-stream"

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": content_type,
        "Content-Disposition": _content_disposition_attachment(basename),
        "Cache-Control": "no-store",
    }

    if size <= 0:
        headers["Content-Length"] = "0"
        return Response(b"", status=200, headers=headers)

    try:
        byte_range = _parse_single_range(request.headers.get("Range"), size)
    except ValueError:
        return Response(
            b"",
            status=416,
            headers={"Accept-Ranges": "bytes", "Content-Range": f"bytes */{size}"},
        )

    start, end = (0, size - 1) if byte_range is None else byte_range
    length = end - start + 1

    if byte_range is not None:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        status_code = 206
    else:
        status_code = 200

    headers["Content-Length"] = str(length)

    if request.method == "HEAD":
        resp = Response(status=status_code)
        resp.headers.update(headers)
        resp.headers["Content-Length"] = str(length)
        return resp

    def generate():
        with open(fs_path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(ROBUST_SHARE_CHUNK_SIZE, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return Response(
        stream_with_context(generate()),
        status=status_code,
        headers=headers,
    )


@app.route("/api/robust-share/<share_id>/download-all")
def robust_share_download_all(share_id: str):
    """Download all files as an archive (tar or zip)."""
    if not is_valid_robust_share_id(share_id):
        return "Invalid share ID", 400

    info = _get_robust_share_info(share_id)
    if not info:
        return "Share not found", 404

    if _robust_share_is_expired(info):
        return "Share expired", 410

    # Check password protection
    if info["password_protected"]:
        token = request.headers.get("X-Session-Token") or request.args.get("token")
        if not _validate_session_token(token, share_id):
            return "Authentication required", 401

    files = _get_robust_share_files(share_id)
    if not files:
        return "No files in share", 404

    download_format = (request.args.get("format") or "").strip().lower()
    if download_format not in {"", "tar", "zip"}:
        return "Invalid format", 400

    source_path = info["source_path"]
    share_type = info["share_type"]
    archive_name = _robust_share_effective_title(info)
    archive_root = _robust_share_archive_root(info) if share_type == "folder" else ""

    if download_format == "zip":
        file_entries: list[dict] = []
        for f in files:
            file_rel = str(f.get("path") or "")
            if share_type == "file":
                fs_path = _robust_share_fs_path(source_path=source_path)
            else:
                fs_path = _robust_share_fs_path(source_path=source_path, rel_path=file_rel)

            if not fs_path or not os.path.isfile(fs_path):
                continue

            try:
                st = os.stat(fs_path)
            except Exception:
                continue

            file_size = int(st.st_size)
            if share_type == "file":
                member_name = file_rel or os.path.basename(source_path.rstrip("/"))
            else:
                member_name = f"{archive_root}/{file_rel}" if archive_root else file_rel
            name_bytes = _zip_member_name_bytes(member_name)
            zip64_sizes = file_size >= 0xFFFFFFFF
            local_header = _zip_local_header(
                name=name_bytes,
                mtime=int(st.st_mtime),
                size=file_size,
                zip64_sizes=zip64_sizes,
            )

            file_entries.append(
                {
                    "fs_path": fs_path,
                    "name": name_bytes,
                    "mtime": int(st.st_mtime),
                    "size": file_size,
                    "zip64_sizes": zip64_sizes,
                    "local_header": local_header,
                }
            )

        if not file_entries:
            return "No files in share", 404

        entries: list[dict] = []
        offset = 0
        cd_size = 0
        for entry in file_entries:
            size = int(entry["size"] or 0)
            zip64_sizes = bool(entry["zip64_sizes"])
            local_header = entry["local_header"]
            local_header_offset = offset
            zip64_offset = local_header_offset >= 0xFFFFFFFF

            extra_len = 0
            if zip64_sizes or zip64_offset:
                extra_len = len(
                    _zip_extra_zip64_central(
                        size=size if zip64_sizes else None,
                        offset=local_header_offset if zip64_offset else None,
                    )
                )
            cd_size += 46 + len(entry["name"]) + extra_len

            dd_len = 24 if zip64_sizes else 16
            offset += len(local_header) + size + dd_len

            entries.append(
                {
                    **entry,
                    "zip64_offset": zip64_offset,
                    "local_header_offset": local_header_offset,
                }
            )

        cd_offset = offset
        eocd = _zip_end_of_central_directory(entries=len(entries), cd_size=cd_size, cd_offset=cd_offset)
        total_length = cd_offset + cd_size + len(eocd)

        def generate_zip():
            central: list[dict] = []
            for entry in entries:
                yield entry["local_header"]

                crc = 0
                remaining = int(entry["size"] or 0)
                with open(entry["fs_path"], "rb") as fh:
                    while remaining > 0:
                        chunk = fh.read(min(ROBUST_SHARE_CHUNK_SIZE, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        crc = zlib.crc32(chunk, crc)
                        yield chunk
                if remaining != 0:
                    raise RuntimeError("Unexpected EOF while reading file")

                yield _zip_data_descriptor(
                    crc32=crc,
                    size=int(entry["size"] or 0),
                    zip64_sizes=bool(entry["zip64_sizes"]),
                )

                central.append({"crc32": crc, **entry})

            for entry in central:
                yield _zip_central_header(
                    name=entry["name"],
                    mtime=int(entry["mtime"] or 0),
                    crc32=int(entry["crc32"] or 0),
                    size=int(entry["size"] or 0),
                    local_header_offset=int(entry["local_header_offset"] or 0),
                    zip64_sizes=bool(entry["zip64_sizes"]),
                    zip64_offset=bool(entry["zip64_offset"]),
                )

            yield eocd

        headers = {
            "Content-Type": "application/zip",
            "Content-Disposition": _content_disposition_attachment(f"{archive_name}.zip"),
            "Cache-Control": "no-store",
            "Content-Length": str(total_length),
        }

        return Response(
            stream_with_context(generate_zip()),
            headers=headers,
        )

    entries: list[dict] = []
    for f in files:
        file_rel = str(f.get("path") or "")
        if share_type == "file":
            fs_path = _robust_share_fs_path(source_path=source_path)
        else:
            fs_path = _robust_share_fs_path(source_path=source_path, rel_path=file_rel)

        if not fs_path or not os.path.isfile(fs_path):
            continue

        try:
            st = os.stat(fs_path)
        except Exception:
            continue

        file_size = int(st.st_size)
        if share_type == "file":
            tar_name = file_rel or os.path.basename(source_path.rstrip("/"))
        else:
            tar_name = f"{archive_root}/{file_rel}" if archive_root else file_rel

        tarinfo = tarfile.TarInfo(name=str(tar_name))
        tarinfo.size = file_size
        tarinfo.mtime = int(st.st_mtime)

        try:
            header = tarinfo.tobuf()
        except Exception:
            continue

        entries.append(
            {
                "fs_path": fs_path,
                "header": header,
                "size": file_size,
                "path": file_rel,
            }
        )

    if not entries:
        return "No files in share", 404

    total_length = 1024  # end-of-archive marker
    for entry in entries:
        size = int(entry["size"] or 0)
        total_length += len(entry["header"]) + size + _tar_padding(size)

    def generate_tar():
        """Generator that streams tar content."""
        for entry in entries:
            fs_path = entry["fs_path"]
            file_size = int(entry["size"] or 0)

            yield entry["header"]

            remaining = file_size
            try:
                with open(fs_path, "rb") as fh:
                    while remaining > 0:
                        chunk = fh.read(min(ROBUST_SHARE_CHUNK_SIZE, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        yield chunk
            except Exception as exc:
                app.logger.error("Error reading file %s: %s", entry.get("path"), exc)

            if remaining > 0:
                yield b"\0" * remaining

            padding = _tar_padding(file_size)
            if padding:
                yield b"\0" * padding

        # Write end-of-archive marker (two 512-byte blocks of zeros)
        yield b"\0" * 1024

    headers = {
        "Content-Type": "application/x-tar",
        "Content-Disposition": _content_disposition_attachment(f"{archive_name}.tar"),
        "Cache-Control": "no-store",
        "Content-Length": str(total_length),
    }

    return Response(
        stream_with_context(generate_tar()),
        headers=headers,
    )


@app.route("/api/robust-share/<share_id>/download-selected", methods=["GET", "POST"])
def robust_share_download_selected(share_id: str):
    """Download selected files as an archive (tar or zip)."""
    if not is_valid_robust_share_id(share_id):
        return jsonify({"error": "Invalid share ID"}), 400

    info = _get_robust_share_info(share_id)
    if not info:
        return jsonify({"error": "Share not found"}), 404

    if _robust_share_is_expired(info):
        return jsonify({"error": "Share expired"}), 410

    # Check password protection
    if info["password_protected"]:
        token = request.headers.get("X-Session-Token") or request.args.get("token")
        if not _validate_session_token(token, share_id):
            return jsonify({"error": "Authentication required"}), 401

    download_format = (request.args.get("format") or "").strip().lower()
    if download_format not in {"", "tar", "zip"}:
        return jsonify({"error": "Invalid format"}), 400

    selected_paths: list[str] = []

    payload = request.get_json(silent=True)
    if isinstance(payload, dict) and isinstance(payload.get("files"), list):
        selected_paths = payload.get("files")  # type: ignore[assignment]
    else:
        query_files = request.args.get("files")
        if query_files:
            try:
                parsed = json.loads(query_files)
                if isinstance(parsed, list):
                    selected_paths = parsed
            except Exception:
                selected_paths = [p.strip() for p in query_files.split(",") if p.strip()]

    if not selected_paths:
        form_files = request.form.get("files")
        if form_files:
            try:
                parsed = json.loads(form_files)
                if isinstance(parsed, list):
                    selected_paths = parsed
            except Exception:
                selected_paths = [p.strip() for p in form_files.split(",") if p.strip()]

    if not selected_paths or not isinstance(selected_paths, list):
        return jsonify({"error": "No files selected"}), 400

    # Validate and filter files
    all_files = _get_robust_share_files(share_id)
    all_paths = {f["path"] for f in all_files}
    selected_set = {p for p in selected_paths if isinstance(p, str)}
    files = [f for f in all_files if f["path"] in selected_set and f["path"] in all_paths]

    if not files:
        return jsonify({"error": "No valid files selected"}), 400

    source_path = info["source_path"]
    share_type = info["share_type"]
    archive_name = _robust_share_effective_title(info)
    tar_names = _unique_flat_tar_names([str(f.get("path") or "") for f in files if isinstance(f, dict)])

    if download_format == "zip":
        file_entries: list[dict] = []
        for f in files:
            file_rel = str(f.get("path") or "")
            if share_type == "file":
                fs_path = _robust_share_fs_path(source_path=source_path)
            else:
                fs_path = _robust_share_fs_path(source_path=source_path, rel_path=file_rel)

            if not fs_path or not os.path.isfile(fs_path):
                continue

            try:
                st = os.stat(fs_path)
            except Exception:
                continue

            file_size = int(st.st_size)
            member_name = tar_names.get(file_rel) or _sanitize_tar_member_name(os.path.basename(file_rel))
            name_bytes = _zip_member_name_bytes(member_name)
            zip64_sizes = file_size >= 0xFFFFFFFF
            local_header = _zip_local_header(
                name=name_bytes,
                mtime=int(st.st_mtime),
                size=file_size,
                zip64_sizes=zip64_sizes,
            )

            file_entries.append(
                {
                    "fs_path": fs_path,
                    "name": name_bytes,
                    "mtime": int(st.st_mtime),
                    "size": file_size,
                    "zip64_sizes": zip64_sizes,
                    "local_header": local_header,
                }
            )

        if not file_entries:
            return jsonify({"error": "No valid files selected"}), 400

        entries: list[dict] = []
        offset = 0
        cd_size = 0
        for entry in file_entries:
            size = int(entry["size"] or 0)
            zip64_sizes = bool(entry["zip64_sizes"])
            local_header = entry["local_header"]
            local_header_offset = offset
            zip64_offset = local_header_offset >= 0xFFFFFFFF

            extra_len = 0
            if zip64_sizes or zip64_offset:
                extra_len = len(
                    _zip_extra_zip64_central(
                        size=size if zip64_sizes else None,
                        offset=local_header_offset if zip64_offset else None,
                    )
                )
            cd_size += 46 + len(entry["name"]) + extra_len

            dd_len = 24 if zip64_sizes else 16
            offset += len(local_header) + size + dd_len

            entries.append(
                {
                    **entry,
                    "zip64_offset": zip64_offset,
                    "local_header_offset": local_header_offset,
                }
            )

        cd_offset = offset
        eocd = _zip_end_of_central_directory(entries=len(entries), cd_size=cd_size, cd_offset=cd_offset)
        total_length = cd_offset + cd_size + len(eocd)

        def generate_zip():
            central: list[dict] = []
            for entry in entries:
                yield entry["local_header"]

                crc = 0
                remaining = int(entry["size"] or 0)
                with open(entry["fs_path"], "rb") as fh:
                    while remaining > 0:
                        chunk = fh.read(min(ROBUST_SHARE_CHUNK_SIZE, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        crc = zlib.crc32(chunk, crc)
                        yield chunk
                if remaining != 0:
                    raise RuntimeError("Unexpected EOF while reading file")

                yield _zip_data_descriptor(
                    crc32=crc,
                    size=int(entry["size"] or 0),
                    zip64_sizes=bool(entry["zip64_sizes"]),
                )

                central.append({"crc32": crc, **entry})

            for entry in central:
                yield _zip_central_header(
                    name=entry["name"],
                    mtime=int(entry["mtime"] or 0),
                    crc32=int(entry["crc32"] or 0),
                    size=int(entry["size"] or 0),
                    local_header_offset=int(entry["local_header_offset"] or 0),
                    zip64_sizes=bool(entry["zip64_sizes"]),
                    zip64_offset=bool(entry["zip64_offset"]),
                )

            yield eocd

        headers = {
            "Content-Type": "application/zip",
            "Content-Disposition": _content_disposition_attachment(f"{archive_name}-selected.zip"),
            "Cache-Control": "no-store",
            "Content-Length": str(total_length),
        }

        return Response(
            stream_with_context(generate_zip()),
            headers=headers,
        )

    entries: list[dict] = []
    for f in files:
        file_rel = str(f.get("path") or "")
        if share_type == "file":
            fs_path = _robust_share_fs_path(source_path=source_path)
        else:
            fs_path = _robust_share_fs_path(source_path=source_path, rel_path=file_rel)

        if not fs_path or not os.path.isfile(fs_path):
            continue

        try:
            st = os.stat(fs_path)
        except Exception:
            continue

        file_size = int(st.st_size)
        member_name = tar_names.get(file_rel) or _sanitize_tar_member_name(os.path.basename(file_rel))
        tarinfo = tarfile.TarInfo(name=member_name)
        tarinfo.size = file_size
        tarinfo.mtime = int(st.st_mtime)

        try:
            header = tarinfo.tobuf()
        except Exception:
            continue

        entries.append(
            {
                "fs_path": fs_path,
                "header": header,
                "size": file_size,
                "path": file_rel,
            }
        )

    if not entries:
        return jsonify({"error": "No valid files selected"}), 400

    total_length = 1024  # end-of-archive marker
    for entry in entries:
        size = int(entry["size"] or 0)
        total_length += len(entry["header"]) + size + _tar_padding(size)

    def generate_tar():
        """Generator that streams tar content for selected files."""
        for entry in entries:
            fs_path = entry["fs_path"]
            file_size = int(entry["size"] or 0)

            yield entry["header"]

            remaining = file_size
            try:
                with open(fs_path, "rb") as fh:
                    while remaining > 0:
                        chunk = fh.read(min(ROBUST_SHARE_CHUNK_SIZE, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        yield chunk
            except Exception as exc:
                app.logger.error("Error reading file %s: %s", entry.get("path"), exc)

            if remaining > 0:
                yield b"\0" * remaining

            padding = _tar_padding(file_size)
            if padding:
                yield b"\0" * padding

        yield b"\0" * 1024

    headers = {
        "Content-Type": "application/x-tar",
        "Content-Disposition": _content_disposition_attachment(f"{archive_name}-selected.tar"),
        "Cache-Control": "no-store",
        "Content-Length": str(total_length),
    }

    return Response(
        stream_with_context(generate_tar()),
        headers=headers,
    )


# ============ UPLOAD REQUEST API ENDPOINTS ============

@app.route("/api/upload-request/create", methods=["POST"])
def create_upload_request():
    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        status = _validate_filebrowser_admin(token)
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502

    if status is not None:
        return jsonify({"error": "Unauthorized"}), status

    payload = request.get_json(silent=True) or {}
    dest_path = payload.get("path") or payload.get("dest_path") or payload.get("destPath")
    if not isinstance(dest_path, str) or not dest_path.strip():
        return jsonify({"error": "Missing destination path"}), 400

    safe_dest = _safe_root_path(dest_path)
    if not safe_dest or safe_dest == "/":
        return jsonify({"error": "Invalid destination path"}), 400

    # Verify destination exists and is a folder in FileBrowser.
    resp = requests.get(
        f"{FILEBROWSER_BASE_URL}/api/resources{quote(safe_dest, safe='/')}",
        headers={"X-Auth": token},
        timeout=30,
    )
    if resp.status_code == 404:
        return jsonify({"error": "Destination not found"}), 404
    if resp.status_code != 200:
        return jsonify({"error": "Failed to access destination"}), 502

    meta = resp.json()
    if not parse_bool(meta.get("isDir")):
        return jsonify({"error": "Destination must be a folder"}), 400

    title = _sanitize_title(payload.get("title"))
    password = payload.get("password") if isinstance(payload.get("password"), str) else ""
    if password and len(password) > MAX_PASSWORD_LENGTH:
        return jsonify({"error": "Password too long"}), 400

    raw_hours = payload.get("expires_hours")
    if raw_hours is None:
        raw_hours = payload.get("expiresHours") or payload.get("expires") or payload.get("hours")
    if raw_hours is None:
        raw_hours = UPLOAD_REQUEST_DEFAULT_EXPIRES_HOURS
    try:
        hours = int(str(raw_hours).strip() or "0")
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid expires_hours"}), 400

    max_hours = 24 * 365 * 10
    if hours < 0 or hours > max_hours:
        return jsonify({"error": f"expires_hours must be between 0 and {max_hours}"}), 400

    raw_max_files = payload.get("max_files")
    if raw_max_files is None:
        raw_max_files = payload.get("maxFiles")
    if raw_max_files is None:
        raw_max_files = UPLOAD_REQUEST_DEFAULT_MAX_FILES
    try:
        max_files = int(str(raw_max_files).strip() or "0")
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid max_files"}), 400
    max_files = max(0, min(max_files, 1000))

    raw_max_mb = payload.get("max_file_size_mb")
    if raw_max_mb is None:
        raw_max_mb = payload.get("maxFileSizeMb") or payload.get("maxFileSizeMB") or payload.get("max_mb")
    if raw_max_mb is None:
        raw_max_mb = UPLOAD_REQUEST_DEFAULT_MAX_FILE_MB
    try:
        max_mb = int(str(raw_max_mb).strip() or "0")
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid max_file_size_mb"}), 400
    max_mb = max(0, min(max_mb, max(1, UPLOAD_REQUEST_HARD_MAX_FILE_MB)))

    allowed_exts = _normalize_allowed_exts(payload.get("allowed_exts") or payload.get("allowedExts") or payload.get("exts"))
    overwrite = parse_bool(payload.get("overwrite") or payload.get("allow_overwrite") or payload.get("allowOverwrite"))
    create_subfolder = parse_bool(payload.get("create_subfolder") if payload.get("create_subfolder") is not None else payload.get("createSubfolder"))
    if payload.get("create_subfolder") is None and payload.get("createSubfolder") is None:
        create_subfolder = True

    raw_share_back = payload.get("share_back")
    if raw_share_back is None:
        raw_share_back = payload.get("shareBack") if payload.get("shareBack") is not None else payload.get("shareBackEnabled")
    if raw_share_back is None:
        share_back_enabled = bool(create_subfolder)
    else:
        share_back_enabled = parse_bool(raw_share_back)

    if share_back_enabled and not create_subfolder:
        return jsonify({"error": "share_back requires create_subfolder=true"}), 400

    request_id = _generate_upload_request_id()

    # Build the actual target folder where files land.
    target_path = safe_dest
    if create_subfolder:
        target_path = f"{safe_dest.rstrip('/')}/_upload_{request_id}"

    safe_target = _safe_root_path(target_path)
    if not safe_target:
        return jsonify({"error": "Invalid target path"}), 400

    fs_target_dir = _robust_share_fs_path(source_path=safe_target)
    if not fs_target_dir:
        return jsonify({"error": "Target path is outside root"}), 400
    try:
        os.makedirs(fs_target_dir, exist_ok=True)
    except OSError as e:
        app.logger.error("Failed to create upload target dir %s: %s", fs_target_dir, e)
        if isinstance(e, PermissionError) or getattr(e, "errno", None) in {errno.EACCES, errno.EPERM, errno.EROFS}:
            return jsonify({"error": "Target folder is not writable by the server"}), 403
        return jsonify({"error": "Failed to create target folder"}), 500

    try:
        if not os.path.isdir(fs_target_dir):
            return jsonify({"error": "Target path is not a folder"}), 400
        if not os.access(fs_target_dir, os.W_OK):
            return jsonify({"error": "Target folder is not writable by the server"}), 403
    except Exception as e:
        app.logger.error("Failed to validate upload target dir %s: %s", fs_target_dir, e)
        return jsonify({"error": "Failed to validate target folder"}), 500

    now = int(time.time())
    expires_at = (now + hours * 3600) if hours > 0 else None
    password_hash = _hash_password(password) if password else None
    max_file_size_bytes = max_mb * 1024 * 1024 if max_mb > 0 else 0
    allowed_exts_json = json.dumps(allowed_exts) if allowed_exts else None

    with _upload_requests_conn() as conn:
        conn.execute(
            """
            INSERT INTO upload_requests (
                request_id,
                dest_path,
                target_path,
                title,
                password_hash,
                expires_at,
                max_files,
                max_file_size_bytes,
                allowed_exts_json,
                overwrite,
                share_back_enabled,
                created_at,
                created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                request_id,
                safe_dest,
                safe_target,
                title,
                password_hash,
                expires_at,
                max_files,
                max_file_size_bytes,
                allowed_exts_json,
                1 if overwrite else 0,
                1 if share_back_enabled else 0,
                now,
                "admin",
            ),
        )

    resp = jsonify(
        {
            "request_id": request_id,
            "upload_url": f"/upload/{request_id}",
            "title": title,
            "password_protected": bool(password),
            "expires_at": expires_at,
            "max_files": max_files,
            "max_file_size_bytes": max_file_size_bytes,
            "allowed_exts": allowed_exts or [],
            "overwrite": overwrite,
            "target_path": safe_target,
            "share_back_enabled": bool(share_back_enabled),
        }
    )
    resp.headers["Cache-Control"] = "no-store"

    try:
        base = PUBLIC_BASE_URL or request.host_url.rstrip("/")
    except Exception:
        base = PUBLIC_BASE_URL or ""

    _schedule_upload_webhook(
        "upload_request.created",
        {
            "event_id": secrets.token_hex(16),
            "event_type": "upload_request.created",
            "created_at": now,
            "request_id": request_id,
            "title": title or "",
            "dest_path": safe_dest,
            "target_path": safe_target,
            "expires_at": expires_at,
            "max_files": max_files,
            "max_file_size_bytes": max_file_size_bytes,
            "allowed_exts": allowed_exts or [],
            "overwrite": bool(overwrite),
            "share_back_enabled": bool(share_back_enabled),
            "upload_url": f"/upload/{request_id}",
            "upload_link": (f"{base}/upload/{request_id}" if base else f"/upload/{request_id}"),
        },
    )

    return resp


@app.route("/api/upload-requests")
def list_upload_requests():
    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        status = _validate_filebrowser_admin(token)
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502

    if status is not None:
        return jsonify({"error": "Unauthorized"}), status

    limit = _parse_int(request.args.get("limit")) or 200
    limit = max(1, min(limit, 1000))

    with _upload_requests_conn() as conn:
        rows = conn.execute(
            """
            SELECT
                r.request_id,
                r.dest_path,
                r.target_path,
                r.title,
                r.password_hash,
                r.expires_at,
                r.max_files,
                r.max_file_size_bytes,
                r.allowed_exts_json,
                r.overwrite,
                r.share_back_enabled,
                r.share_back_share_id,
                r.share_back_created_at,
                r.created_at,
                r.disabled_at,
                COUNT(f.id) AS uploaded_files,
                COALESCE(SUM(f.size_bytes), 0) AS uploaded_bytes
            FROM upload_requests r
            LEFT JOIN upload_files f ON f.request_id = r.request_id
            GROUP BY r.request_id
            ORDER BY r.created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        active_session_rows = conn.execute(
            """
            SELECT
                request_id,
                size_bytes,
                chunk_size_bytes,
                chunk_count,
                received_json,
                checksum_algorithm,
                updated_at
            FROM upload_sessions
            WHERE status IN ('active', 'committing')
            """
        ).fetchall()

    active_by_request: dict[str, dict] = {}
    for session_row in active_session_rows:
        request_key = str(session_row["request_id"] or "")
        if not request_key:
            continue
        aggregate = active_by_request.setdefault(
            request_key,
            {
                "count": 0,
                "received_bytes": 0,
                "total_bytes": 0,
                "verified_count": 0,
                "last_updated_at": 0,
            },
        )
        session_dict = dict(session_row)
        aggregate["count"] += 1
        aggregate["received_bytes"] += _upload_session_received_bytes(session_dict)
        aggregate["total_bytes"] += int(session_row["size_bytes"] or 0)
        if str(session_row["checksum_algorithm"] or "").lower() == "sha256":
            aggregate["verified_count"] += 1
        aggregate["last_updated_at"] = max(
            int(aggregate["last_updated_at"] or 0),
            int(session_row["updated_at"] or 0),
        )

    now = int(time.time())
    out = []
    for row in rows:
        active = active_by_request.get(str(row["request_id"]), {})
        active_total = int(active.get("total_bytes") or 0)
        active_received = int(active.get("received_bytes") or 0)
        allowed_exts = []
        try:
            if row["allowed_exts_json"]:
                parsed = json.loads(row["allowed_exts_json"])
                allowed_exts = _normalize_allowed_exts(parsed) or []
        except Exception:
            allowed_exts = []

        expires_at = int(row["expires_at"] or 0) if row["expires_at"] else None
        disabled_at = int(row["disabled_at"] or 0) if row["disabled_at"] else None
        status = "active"
        if disabled_at is not None:
            status = "disabled"
        elif expires_at is not None and expires_at > 0 and now >= expires_at:
            status = "expired"

        out.append(
            {
                "request_id": str(row["request_id"]),
                "upload_url": f"/upload/{row['request_id']}",
                "title": str(row["title"] or ""),
                "password_protected": bool(row["password_hash"]),
                "expires_at": expires_at,
                "dest_path": str(row["dest_path"]),
                "target_path": str(row["target_path"]),
                "max_files": int(row["max_files"] or 0),
                "max_file_size_bytes": int(row["max_file_size_bytes"] or 0),
                "allowed_exts": allowed_exts,
                "overwrite": bool(int(row["overwrite"] or 0)),
                "share_back_enabled": bool(int(row["share_back_enabled"] or 0)),
                "share_back_share_id": (str(row["share_back_share_id"]) if row["share_back_share_id"] else None),
                "share_back_created_at": int(row["share_back_created_at"] or 0) if row["share_back_created_at"] else None,
                "share_back_url": (
                    f"/share/{row['share_back_share_id']}"
                    if (row["share_back_share_id"] and is_valid_robust_share_id(str(row["share_back_share_id"])))
                    else None
                ),
                "created_at": int(row["created_at"] or 0),
                "disabled_at": disabled_at,
                "status": status,
                "uploaded_files": int(row["uploaded_files"] or 0),
                "uploaded_bytes": int(row["uploaded_bytes"] or 0),
                "active_session_count": int(active.get("count") or 0),
                "active_received_bytes": active_received,
                "active_total_bytes": active_total,
                "active_progress": (active_received / active_total if active_total > 0 else 0.0),
                "active_verified_count": int(active.get("verified_count") or 0),
                "active_last_updated_at": int(active.get("last_updated_at") or 0) or None,
            }
        )

    resp = jsonify({"requests": out, "count": len(out)})
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/upload-request/<request_id>/detail", methods=["GET"])
def upload_request_detail(request_id: str):
    """Return admin-only audit details for an upload request."""
    if not is_valid_upload_request_id(request_id):
        return jsonify({"error": "Invalid request ID"}), 400

    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        status = _validate_filebrowser_admin(token)
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502

    if status is not None:
        return jsonify({"error": "Unauthorized"}), status

    info = _get_upload_request(request_id)
    if not info:
        return jsonify({"error": "Not found"}), 404

    file_limit = _parse_int(request.args.get("files_limit")) or 500
    file_limit = max(1, min(file_limit, 1000))

    with _upload_requests_conn() as conn:
        summary = conn.execute(
            """
            SELECT COUNT(1) AS c, COALESCE(SUM(size_bytes), 0) AS bytes
            FROM upload_files
            WHERE request_id = ?
            """,
            (request_id,),
        ).fetchone()
        rows = conn.execute(
            """
            SELECT
                id,
                original_name,
                stored_name,
                size_bytes,
                content_type,
                created_at
            FROM upload_files
            WHERE request_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (request_id, file_limit),
        ).fetchall()
        session_rows = conn.execute(
            """
            SELECT
                session_id,
                original_name,
                stored_name,
                size_bytes,
                chunk_size_bytes,
                chunk_count,
                received_json,
                status,
                checksum_algorithm,
                created_at,
                updated_at,
                commit_error
            FROM upload_sessions
            WHERE request_id = ? AND status IN ('active', 'committing')
            ORDER BY updated_at DESC, created_at DESC
            """,
            (request_id,),
        ).fetchall()

    now = int(time.time())
    status_name = "active"
    if info.get("disabled_at") is not None:
        status_name = "disabled"
    elif _upload_request_is_expired(info, now=now):
        status_name = "expired"

    files = []
    for row in rows:
        stored_name = str(row["stored_name"] or "")
        target_path = str(info.get("target_path") or "").rstrip("/")
        stored_path = f"{target_path}/{stored_name}" if target_path else stored_name
        files.append(
            {
                "original_name": str(row["original_name"] or ""),
                "stored_name": stored_name,
                "stored_path": stored_path,
                "size_bytes": int(row["size_bytes"] or 0),
                "content_type": str(row["content_type"] or ""),
                "created_at": int(row["created_at"] or 0),
            }
        )

    sessions = []
    active_received_bytes = 0
    active_total_bytes = 0
    for row in session_rows:
        session_dict = dict(row)
        received_bytes = _upload_session_received_bytes(session_dict)
        size_bytes = int(row["size_bytes"] or 0)
        received_count = len(_upload_session_received(session_dict))
        chunk_count = int(row["chunk_count"] or 0)
        updated_at = int(row["updated_at"] or 0)
        active_received_bytes += received_bytes
        active_total_bytes += size_bytes
        sessions.append(
            {
                "session_id": str(row["session_id"] or ""),
                "original_name": str(row["original_name"] or ""),
                "stored_name": str(row["stored_name"] or ""),
                "size_bytes": size_bytes,
                "received_bytes": received_bytes,
                "progress": (received_bytes / size_bytes if size_bytes > 0 else 0.0),
                "chunk_size_bytes": int(row["chunk_size_bytes"] or 0),
                "chunk_count": chunk_count,
                "received_count": received_count,
                "status": str(row["status"] or "active"),
                "checksum_algorithm": str(row["checksum_algorithm"] or ""),
                "verified": str(row["checksum_algorithm"] or "").lower() == "sha256",
                "created_at": int(row["created_at"] or 0),
                "updated_at": updated_at,
                "idle_seconds": max(0, now - updated_at) if updated_at > 0 else None,
                "commit_error": str(row["commit_error"] or ""),
            }
        )

    uploaded_file_count = int(summary["c"] or 0) if summary else 0
    total_bytes = int(summary["bytes"] or 0) if summary else 0

    share_back_enabled = bool(info.get("share_back_enabled"))
    share_back_share_id = info.get("share_back_share_id")
    share_back_url = None
    share_back_state = "disabled"
    share_back_detail = {
        "enabled": share_back_enabled,
        "state": share_back_state,
        "share_id": None,
        "share_url": None,
        "created_at": info.get("share_back_created_at"),
        "expires_at": None,
        "file_count": 0,
        "total_size": 0,
    }
    if share_back_enabled:
        share_back_state = "not_created"
        if share_back_share_id and is_valid_robust_share_id(str(share_back_share_id)):
            share_info = _get_robust_share_info(str(share_back_share_id))
            if share_info:
                share_back_state = "expired" if _robust_share_is_expired(share_info, now=now) else "active"
                share_back_url = f"/share/{share_back_share_id}"
                share_back_detail.update(
                    {
                        "share_id": str(share_back_share_id),
                        "share_url": share_back_url,
                        "expires_at": share_info.get("expires_at"),
                        "file_count": int(share_info.get("file_count") or 0),
                        "total_size": int(share_info.get("total_size") or 0),
                    }
                )
            else:
                share_back_state = "missing"
                share_back_detail["share_id"] = str(share_back_share_id)
        share_back_detail["state"] = share_back_state

    detail = {
        "request_id": info["request_id"],
        "upload_url": f"/upload/{request_id}",
        "title": str(info.get("title") or ""),
        "password_protected": bool(info.get("password_protected")),
        "expires_at": info.get("expires_at"),
        "dest_path": str(info.get("dest_path") or ""),
        "target_path": str(info.get("target_path") or ""),
        "max_files": int(info.get("max_files") or 0),
        "max_file_size_bytes": int(info.get("max_file_size_bytes") or 0),
        "allowed_exts": info.get("allowed_exts") or [],
        "overwrite": bool(info.get("overwrite")),
        "share_back_enabled": share_back_enabled,
        "share_back_share_id": share_back_share_id,
        "share_back_created_at": info.get("share_back_created_at"),
        "share_back_state": share_back_state,
        "share_back_url": share_back_url,
        "share_back": share_back_detail,
        "created_at": int(info.get("created_at") or 0),
        "created_by": info.get("created_by"),
        "disabled_at": info.get("disabled_at"),
        "status": status_name,
        "uploaded_files": uploaded_file_count,
        "uploaded_bytes": int(total_bytes),
        "active_session_count": len(sessions),
        "active_received_bytes": int(active_received_bytes),
        "active_total_bytes": int(active_total_bytes),
        "active_progress": (active_received_bytes / active_total_bytes if active_total_bytes > 0 else 0.0),
        "sessions": sessions,
        "files_returned": len(files),
        "files_limit": file_limit,
        "files": files,
    }

    resp = jsonify({"request": detail})
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/upload-request/<request_id>/session/<session_id>/admin", methods=["DELETE"])
def admin_cancel_upload_request_session(request_id: str, session_id: str):
    """Cancel an active partial upload using FileBrowser admin authentication."""
    if not is_valid_upload_request_id(request_id) or not is_valid_upload_session_id(session_id):
        return jsonify({"error": "Invalid upload session"}), 400

    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401
    try:
        auth_status = _validate_filebrowser_admin(token)
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502
    if auth_status is not None:
        return jsonify({"error": "Unauthorized"}), auth_status

    info = _get_upload_request(request_id)
    if not info:
        return jsonify({"error": "Upload request not found"}), 404

    canceled: dict | None = None
    try:
        with _upload_session_lock(session_id):
            session = _load_upload_session(session_id)
            if not session or str(session.get("request_id") or "") != request_id:
                raise UploadSessionError(404, "Upload session not found")
            session_status = str(session.get("status") or "")
            if session_status == "committing":
                raise UploadSessionError(409, "Upload is currently committing and cannot be canceled")
            if session_status == "committed":
                raise UploadSessionError(409, "Committed uploads cannot be canceled")

            received_bytes = _upload_session_received_bytes(session)
            temp_path = _upload_session_temp_path(info, session_id)
            try:
                os.remove(temp_path)
            except FileNotFoundError:
                pass
            try:
                os.rmdir(os.path.dirname(temp_path))
            except OSError:
                pass
            with _upload_requests_conn() as conn:
                conn.execute("DELETE FROM upload_sessions WHERE session_id = ?", (session_id,))
            canceled = {
                "session_id": session_id,
                "filename": str(session.get("original_name") or ""),
                "received_bytes": received_bytes,
                "size_bytes": int(session.get("size_bytes") or 0),
            }
        try:
            os.remove(_upload_session_lock_path(session_id))
        except FileNotFoundError:
            pass
    except UploadSessionError as e:
        return jsonify({"error": e.message}), e.status

    resp = jsonify({"ok": True, "canceled": canceled})
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/upload-request/<request_id>/export.csv", methods=["GET"])
def upload_request_export_csv(request_id: str):
    """Stream an admin-only CSV audit export for an upload request."""
    if not is_valid_upload_request_id(request_id):
        return "Invalid request ID", 400

    token = _get_auth_token()
    if not token:
        return "Missing auth token", 401

    try:
        status = _validate_filebrowser_admin(token)
    except Exception as e:
        return f"Failed to validate auth: {e}", 502

    if status is not None:
        return "Unauthorized", status

    info = _get_upload_request(request_id)
    if not info:
        return "Not found", 404

    now = int(time.time())
    status_name = "active"
    if info.get("disabled_at") is not None:
        status_name = "disabled"
    elif _upload_request_is_expired(info, now=now):
        status_name = "expired"

    share_back_state = "disabled"
    if bool(info.get("share_back_enabled")):
        share_back_state = "not_created"
        share_back_share_id = info.get("share_back_share_id")
        if share_back_share_id and is_valid_robust_share_id(str(share_back_share_id)):
            share_info = _get_robust_share_info(str(share_back_share_id))
            if share_info:
                share_back_state = "expired" if _robust_share_is_expired(share_info, now=now) else "active"
            else:
                share_back_state = "missing"

    target_path = str(info.get("target_path") or "").rstrip("/")
    title = str(info.get("title") or "")
    dest_path = str(info.get("dest_path") or "")

    def generate():
        yield _csv_row(
            [
                "request_id",
                "title",
                "status",
                "dest_path",
                "target_path",
                "share_back_state",
                "original_name",
                "stored_name",
                "stored_path",
                "size_bytes",
                "content_type",
                "uploaded_at",
                "uploaded_at_iso",
            ]
        )

        with _upload_requests_conn() as conn:
            cursor = conn.execute(
                """
                SELECT original_name, stored_name, size_bytes, content_type, created_at
                FROM upload_files
                WHERE request_id = ?
                ORDER BY created_at DESC, id DESC
                """,
                (request_id,),
            )

            while True:
                batch = cursor.fetchmany(100)
                if not batch:
                    break

                for row in batch:
                    stored_name = str(row["stored_name"] or "")
                    stored_path = f"{target_path}/{stored_name}" if target_path else stored_name
                    uploaded_at = int(row["created_at"] or 0)
                    uploaded_iso = ""
                    if uploaded_at > 0:
                        uploaded_iso = datetime.datetime.fromtimestamp(
                            uploaded_at,
                            tz=datetime.timezone.utc,
                        ).isoformat()

                    yield _csv_row(
                        [
                            request_id,
                            title,
                            status_name,
                            dest_path,
                            target_path,
                            share_back_state,
                            str(row["original_name"] or ""),
                            stored_name,
                            stored_path,
                            int(row["size_bytes"] or 0),
                            str(row["content_type"] or ""),
                            uploaded_at,
                            uploaded_iso,
                        ]
                    )

    return Response(
        stream_with_context(generate()),
        content_type="text/csv; charset=utf-8",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "Content-Disposition": _content_disposition_attachment(f"droppr-upload-{request_id}.csv"),
        },
    )


@app.route("/api/upload-request/<request_id>", methods=["DELETE"])
def disable_upload_request(request_id: str):
    if not is_valid_upload_request_id(request_id):
        return jsonify({"error": "Invalid request ID"}), 400

    token = _get_auth_token()
    if not token:
        return jsonify({"error": "Missing auth token"}), 401

    try:
        status = _validate_filebrowser_admin(token)
    except Exception as e:
        return jsonify({"error": f"Failed to validate auth: {e}"}), 502

    if status is not None:
        return jsonify({"error": "Unauthorized"}), status

    now = int(time.time())
    with _upload_requests_conn() as conn:
        row = conn.execute(
            "SELECT request_id, disabled_at FROM upload_requests WHERE request_id = ? LIMIT 1",
            (request_id,),
        ).fetchone()
        if not row:
            return jsonify({"error": "Not found"}), 404

        if row["disabled_at"] is None:
            conn.execute("UPDATE upload_requests SET disabled_at = ? WHERE request_id = ?", (now, request_id))

    resp = jsonify({"ok": True, "request_id": request_id})
    resp.headers["Cache-Control"] = "no-store"

    try:
        base = PUBLIC_BASE_URL or request.host_url.rstrip("/")
    except Exception:
        base = PUBLIC_BASE_URL or ""

    _schedule_upload_webhook(
        "upload_request.disabled",
        {
            "event_id": secrets.token_hex(16),
            "event_type": "upload_request.disabled",
            "created_at": now,
            "request_id": request_id,
            "upload_url": f"/upload/{request_id}",
            "upload_link": (f"{base}/upload/{request_id}" if base else f"/upload/{request_id}"),
        },
    )

    return resp


@app.route("/api/upload-request/<request_id>/info")
def upload_request_info(request_id: str):
    if not is_valid_upload_request_id(request_id):
        return jsonify({"error": "Invalid request ID"}), 400

    info = _get_upload_request(request_id)
    if not info:
        return jsonify({"error": "Not found"}), 404

    if _upload_request_is_disabled(info):
        return jsonify({"error": "Request disabled"}), 410

    if _upload_request_is_expired(info):
        return jsonify({"error": "Request expired"}), 410

    resp = jsonify(
        {
            "request_id": info["request_id"],
            "title": info.get("title") or "Upload files",
            "password_protected": bool(info.get("password_protected")),
            "expires_at": info.get("expires_at"),
            "max_files": info.get("max_files") or 0,
            "max_file_size_bytes": info.get("max_file_size_bytes") or 0,
            "allowed_exts": info.get("allowed_exts") or [],
            "overwrite": bool(info.get("overwrite")),
            "share_back_enabled": bool(info.get("share_back_enabled")),
            "resumable": True,
            "resumable_checksum_algorithms": ["sha256"],
            "resumable_chunk_size_bytes": _choose_upload_session_chunk_size(
                max(1, int(info.get("max_file_size_bytes") or _effective_upload_request_max_bytes(info)))
            ),
        }
    )
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/upload-request/<request_id>/verify", methods=["POST"])
def upload_request_verify(request_id: str):
    if not is_valid_upload_request_id(request_id):
        return jsonify({"error": "Invalid request ID"}), 400

    info = _get_upload_request(request_id)
    if not info:
        return jsonify({"error": "Not found"}), 404

    if _upload_request_is_disabled(info):
        return jsonify({"error": "Request disabled"}), 410

    if _upload_request_is_expired(info):
        return jsonify({"error": "Request expired"}), 410

    if not info.get("password_protected"):
        resp = jsonify({"valid": True, "token": None})
        resp.headers["Cache-Control"] = "no-store"
        return resp

    ip = _get_client_ip() or request.remote_addr or ""
    if not _check_rate_limit(f"uploadreq:{request_id}:{ip}", max_requests=8, window_seconds=60):
        return jsonify({"error": "Too many attempts"}), 429

    payload = request.get_json(silent=True) or {}
    password = payload.get("password") if isinstance(payload.get("password"), str) else ""
    if not password:
        return jsonify({"valid": False, "error": "Missing password"}), 400

    password_hash = info.get("password_hash") or ""
    if not password_hash:
        return jsonify({"valid": False, "error": "No password set"}), 400

    if not _verify_password(password, password_hash):
        return jsonify({"valid": False, "error": "Invalid password"}), 401

    token = _create_upload_request_token(request_id, client_ip=(ip or None))
    resp = jsonify({"valid": True, "token": token})
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/upload-request/<request_id>/session", methods=["POST"])
def create_upload_request_session(request_id: str):
    """Create a resumable, bearer-token-protected upload session."""
    try:
        if not is_valid_upload_request_id(request_id):
            raise UploadSessionError(400, "Invalid request ID")
        info = _get_upload_request(request_id)
        if not info:
            raise UploadSessionError(404, "Upload request not found")
        if _upload_request_is_disabled(info):
            raise UploadSessionError(410, "Upload request is disabled")
        if _upload_request_is_expired(info):
            raise UploadSessionError(410, "Upload request is expired")

        ip = _get_client_ip() or request.remote_addr or ""
        if info.get("password_protected"):
            token = request.headers.get("X-Session-Token") or request.args.get("token")
            if not _validate_upload_request_token(str(token or ""), request_id, client_ip=(ip or None)):
                raise UploadSessionError(401, "Authentication required")
        if not _check_rate_limit(f"upload-session:{request_id}:{ip}", max_requests=60, window_seconds=60):
            raise UploadSessionError(429, "Too many upload sessions requested")

        payload = request.get_json(silent=True) or {}
        original_name = _safe_upload_filename(payload.get("filename"))
        if not original_name:
            raise UploadSessionError(400, "Invalid filename")
        try:
            size = int(payload.get("size") or 0)
        except Exception:
            size = 0
        max_bytes = _effective_upload_request_max_bytes(info)
        if size <= 0 or size > max_bytes:
            raise UploadSessionError(413, f"File size must be between 1 and {max_bytes} bytes")

        ext = _file_ext(original_name)
        allowed_exts = set(info.get("allowed_exts") or [])
        if allowed_exts and ext not in allowed_exts:
            raise UploadSessionError(400, f"File type not allowed: .{ext or ''}")

        content_type = str(payload.get("content_type") or "")[:255] or None
        checksum_algorithm = str(payload.get("checksum_algorithm") or "").strip().lower()
        if checksum_algorithm not in {"", "sha256"}:
            raise UploadSessionError(400, "Unsupported chunk checksum algorithm")
        checksum_algorithm = checksum_algorithm or None
        try:
            last_modified = int(payload.get("last_modified")) if payload.get("last_modified") is not None else None
        except Exception:
            last_modified = None
        session_id = _generate_upload_session_id()
        resume_token = _generate_session_token()
        chunk_size = _choose_upload_session_chunk_size(size)
        chunk_count = (size + chunk_size - 1) // chunk_size
        now = int(time.time())

        _cleanup_stale_upload_sessions_once()
        with _upload_session_lock(request_id):
            max_files = int(info.get("max_files") or 0)
            with _upload_requests_conn() as conn:
                uploaded_row = conn.execute(
                    "SELECT COUNT(1) AS c FROM upload_files WHERE request_id = ?",
                    (request_id,),
                ).fetchone()
                active_row = conn.execute(
                    "SELECT COUNT(1) AS c FROM upload_sessions WHERE request_id = ? AND status IN ('active', 'committing')",
                    (request_id,),
                ).fetchone()
            uploaded_count = int(uploaded_row["c"] or 0)
            active_count = int(active_row["c"] or 0)
            if max_files > 0 and uploaded_count >= max_files:
                raise UploadSessionError(409, f"File limit reached ({max_files})")
            # Active sessions do not consume the final file allowance. Otherwise
            # losing local browser storage would strand a one-file request until
            # stale-session cleanup. Keep a separate cap to bound abandoned data.
            if active_count >= UPLOAD_SESSION_MAX_ACTIVE_PER_REQUEST:
                raise UploadSessionError(
                    409,
                    "Too many active upload sessions; resume or cancel an existing transfer",
                )

            stored_name = _pick_upload_session_name(info, original_name)
            session = {
                "session_id": session_id,
                "request_id": request_id,
                "original_name": original_name,
                "stored_name": stored_name,
                "size_bytes": size,
                "content_type": content_type,
                "last_modified": last_modified,
                "chunk_size_bytes": chunk_size,
                "chunk_count": chunk_count,
                "received_json": "[]",
                "status": "active",
            }
            _ensure_upload_session_space(info, session)
            temp_path = _upload_session_temp_path(info, session_id)
            try:
                fd = os.open(temp_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640)
                try:
                    temp_stat = os.fstat(fd)
                finally:
                    os.close(fd)
                with _upload_requests_conn() as conn:
                    conn.execute(
                        """
                        INSERT INTO upload_sessions (
                            session_id, resume_token_hash, request_id, original_name, stored_name,
                            size_bytes, content_type, last_modified, chunk_size_bytes, chunk_count,
                            received_json, status, overwrite, client_ip, user_agent, created_at, updated_at,
                            temp_device, temp_inode, checksum_algorithm
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'active', ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            session_id,
                            _hash_session_token(resume_token),
                            request_id,
                            original_name,
                            stored_name,
                            size,
                            content_type,
                            last_modified,
                            chunk_size,
                            chunk_count,
                            1 if info.get("overwrite") else 0,
                            ip or None,
                            request.headers.get("User-Agent"),
                            now,
                            now,
                            int(temp_stat.st_dev),
                            int(temp_stat.st_ino),
                            checksum_algorithm,
                        ),
                    )
            except Exception:
                try:
                    os.remove(temp_path)
                except FileNotFoundError:
                    pass
                raise

        created = _load_upload_session(session_id)
        if not created:
            raise UploadSessionError(500, "Failed to create upload session")
        resp = jsonify(
            {
                "ok": True,
                "session_id": session_id,
                "upload_token": resume_token,
                "status": _upload_session_status(created),
            }
        )
        resp.status_code = 201
        resp.headers["Cache-Control"] = "no-store"
        return resp
    except UploadSessionError as e:
        return jsonify({"error": e.message}), e.status
    except Exception as e:
        app.logger.exception("Failed to create resumable upload session: %s", e)
        return jsonify({"error": "Failed to create upload session"}), 500


@app.route("/api/upload-request/<request_id>/session/<session_id>", methods=["GET"])
def get_upload_request_session(request_id: str, session_id: str):
    try:
        session, _info = _require_upload_session(request_id, session_id)
        resp = jsonify({"ok": True, "status": _upload_session_status(session)})
        resp.headers["Cache-Control"] = "no-store"
        return resp
    except UploadSessionError as e:
        return jsonify({"error": e.message}), e.status


@app.route("/api/upload-request/<request_id>/session/<session_id>/chunk/<int:index>", methods=["PUT"])
def put_upload_request_session_chunk(request_id: str, session_id: str, index: int):
    try:
        with _upload_session_lock(session_id):
            session, info = _require_upload_session(request_id, session_id)
            if str(session.get("status") or "") == "committed":
                raise UploadSessionError(409, "Upload is already committed")
            if str(session.get("status") or "") == "committing":
                raise UploadSessionError(409, "Upload is being committed")

            expected_size = _upload_session_expected_chunk_size(session, index)
            content_length = request.content_length
            if content_length is None:
                raise UploadSessionError(411, "Content-Length is required")
            if int(content_length) != expected_size:
                raise UploadSessionError(400, f"Unexpected chunk size: got {content_length}, expected {expected_size}")

            checksum_algorithm = str(session.get("checksum_algorithm") or "").lower()
            expected_checksum = ""
            if checksum_algorithm == "sha256":
                expected_checksum = str(request.headers.get("X-Chunk-SHA256") or "").strip().lower()
                if not re.fullmatch(r"[a-f0-9]{64}", expected_checksum):
                    raise UploadSessionError(400, "A valid X-Chunk-SHA256 header is required")

            received = _upload_session_received(session)
            if index in received:
                resp = jsonify({"ok": True, "already_received": True, "status": _upload_session_status(session)})
                resp.headers["Cache-Control"] = "no-store"
                return resp

            _ensure_upload_session_space(info, session)
            temp_path = _upload_session_temp_path(info, session_id)
            if not os.path.isfile(temp_path):
                raise UploadSessionError(409, "Temporary upload data is missing; start a new session")

            remaining = expected_size
            offset = index * int(session.get("chunk_size_bytes") or 0)
            chunk_digest = hashlib.sha256() if checksum_algorithm == "sha256" else None
            with open(temp_path, "r+b") as output:
                output.seek(offset)
                while remaining > 0:
                    block = request.stream.read(min(UPLOAD_REQUEST_STREAM_CHUNK_SIZE, remaining))
                    if not block:
                        raise UploadSessionError(400, "Connection ended before the chunk was complete")
                    output.write(block)
                    if chunk_digest is not None:
                        chunk_digest.update(block)
                    remaining -= len(block)
                if chunk_digest is not None:
                    actual_checksum = chunk_digest.hexdigest()
                    if not hmac.compare_digest(actual_checksum, expected_checksum):
                        raise UploadSessionError(422, "Chunk checksum verification failed")
                output.flush()
                os.fsync(output.fileno())

            received.add(index)
            now = int(time.time())
            with _upload_requests_conn() as conn:
                conn.execute(
                    "UPDATE upload_sessions SET received_json = ?, updated_at = ?, commit_error = NULL WHERE session_id = ?",
                    (json.dumps(sorted(received), separators=(",", ":")), now, session_id),
                )
            current = _load_upload_session(session_id)
            resp = jsonify(
                {
                    "ok": True,
                    "index": index,
                    "verified": bool(chunk_digest is not None),
                    "checksum_sha256": (chunk_digest.hexdigest() if chunk_digest is not None else None),
                    "status": _upload_session_status(current or session),
                }
            )
            resp.headers["Cache-Control"] = "no-store"
            return resp
    except UploadSessionError as e:
        return jsonify({"error": e.message}), e.status
    except Exception as e:
        app.logger.exception("Resumable chunk upload failed for %s: %s", session_id, e)
        return jsonify({"error": "Chunk upload failed"}), 500


@app.route("/api/upload-request/<request_id>/session/<session_id>/commit", methods=["POST"])
def commit_upload_request_session(request_id: str, session_id: str):
    newly_committed = False
    result: dict | None = None
    info: dict | None = None
    client_ip: str | None = None
    user_agent: str | None = None
    try:
        with _upload_session_lock(session_id):
            session, info = _require_upload_session(request_id, session_id)
            client_ip = str(session.get("client_ip") or "") or None
            user_agent = str(session.get("user_agent") or "") or None
            if str(session.get("status") or "") == "committed":
                result = {
                    "original_name": str(session.get("original_name") or ""),
                    "stored_name": str(session.get("stored_name") or ""),
                    "size_bytes": int(session.get("size_bytes") or 0),
                }
            else:
                status = _upload_session_status(session)
                if not status["complete"]:
                    raise UploadSessionError(409, "Not all chunks have been uploaded")

                with _upload_session_lock(request_id):
                    temp_path = _upload_session_temp_path(info, session_id)
                    stored_name = str(session.get("stored_name") or "")
                    final_path = _upload_session_final_path(info, stored_name)
                    committing = str(session.get("status") or "") == "committing"

                    temp_device = int(session.get("temp_device") or 0)
                    temp_inode = int(session.get("temp_inode") or 0)
                    if (temp_device <= 0 or temp_inode <= 0) and os.path.isfile(temp_path):
                        # Backfill sessions created before file identity tracking
                        # was deployed, before crossing the commit crash window.
                        temp_stat = os.stat(temp_path)
                        temp_device = int(temp_stat.st_dev)
                        temp_inode = int(temp_stat.st_ino)
                        with _upload_requests_conn() as conn:
                            conn.execute(
                                "UPDATE upload_sessions SET temp_device = ?, temp_inode = ? WHERE session_id = ?",
                                (temp_device, temp_inode, session_id),
                            )
                        session["temp_device"] = temp_device
                        session["temp_inode"] = temp_inode

                    final_stat = None
                    if committing and temp_device > 0 and temp_inode > 0:
                        try:
                            final_stat = os.stat(final_path)
                        except FileNotFoundError:
                            final_stat = None
                    already_moved = bool(
                        final_stat
                        and int(final_stat.st_dev) == temp_device
                        and int(final_stat.st_ino) == temp_inode
                        and int(final_stat.st_size) == int(session["size_bytes"])
                    )
                    if not already_moved:
                        max_files = int(info.get("max_files") or 0)
                        if max_files > 0:
                            with _upload_requests_conn() as conn:
                                committed_row = conn.execute(
                                    """
                                    SELECT
                                        COUNT(1) AS total,
                                        SUM(CASE WHEN upload_session_id = ? THEN 1 ELSE 0 END) AS own
                                    FROM upload_files
                                    WHERE request_id = ?
                                    """,
                                    (session_id, request_id),
                                ).fetchone()
                            committed_total = int(committed_row["total"] or 0)
                            committed_own = int(committed_row["own"] or 0)
                            if committed_own == 0 and committed_total >= max_files:
                                raise UploadSessionError(409, f"File limit reached ({max_files})")
                    if already_moved and os.path.exists(temp_path):
                        try:
                            if os.path.samefile(temp_path, final_path):
                                os.unlink(temp_path)
                        except OSError:
                            pass
                    if not already_moved:
                        if not os.path.isfile(temp_path):
                            raise UploadSessionError(409, "Temporary upload data is missing")
                        if os.path.getsize(temp_path) != int(session["size_bytes"]):
                            raise UploadSessionError(409, "Temporary upload size does not match the file size")

                        if bool(session.get("overwrite")):
                            with _upload_requests_conn() as conn:
                                conn.execute(
                                    "UPDATE upload_sessions SET status = 'committing', commit_error = NULL, updated_at = ? WHERE session_id = ?",
                                    (int(time.time()), session_id),
                                )
                            os.replace(temp_path, final_path)
                        else:
                            while True:
                                if os.path.exists(final_path):
                                    stored_name = _pick_upload_session_name(
                                        info,
                                        str(session.get("original_name") or "upload"),
                                        exclude_session_id=session_id,
                                    )
                                    final_path = _upload_session_final_path(info, stored_name)
                                    session["stored_name"] = stored_name
                                with _upload_requests_conn() as conn:
                                    conn.execute(
                                        """
                                        UPDATE upload_sessions
                                        SET status = 'committing', stored_name = ?, commit_error = NULL, updated_at = ?
                                        WHERE session_id = ?
                                        """,
                                        (stored_name, int(time.time()), session_id),
                                    )
                                try:
                                    os.link(temp_path, final_path)
                                    os.unlink(temp_path)
                                    break
                                except FileExistsError:
                                    continue

                    os.chmod(final_path, 0o640)
                    last_modified = session.get("last_modified")
                    if last_modified:
                        try:
                            modified_at = int(last_modified) / 1000
                            os.utime(final_path, (modified_at, modified_at))
                        except Exception:
                            pass

                    try:
                        os.rmdir(os.path.dirname(temp_path))
                    except OSError:
                        pass

                    committed_at = int(time.time())
                    with _upload_requests_conn() as conn:
                        conn.execute(
                            """
                            INSERT OR IGNORE INTO upload_files (
                                request_id, original_name, stored_name, size_bytes, content_type,
                                client_ip, user_agent, upload_session_id, created_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                request_id,
                                str(session.get("original_name") or ""),
                                stored_name,
                                int(session.get("size_bytes") or 0),
                                str(session.get("content_type") or "") or None,
                                client_ip,
                                user_agent,
                                session_id,
                                committed_at,
                            ),
                        )
                        conn.execute(
                            """
                            UPDATE upload_sessions
                            SET status = 'committed', committed_at = ?, updated_at = ?, commit_error = NULL, stored_name = ?
                            WHERE session_id = ?
                            """,
                            (committed_at, committed_at, stored_name, session_id),
                        )
                    result = {
                        "original_name": str(session.get("original_name") or ""),
                        "stored_name": stored_name,
                        "size_bytes": int(session.get("size_bytes") or 0),
                    }
                    newly_committed = True

        if newly_committed and info and result:
            _schedule_resumable_upload_webhook(info, result, client_ip=client_ip, user_agent=user_agent)
        resp = jsonify({"ok": True, "uploaded": result, "status": _upload_session_status(_load_upload_session(session_id) or session)})
        resp.headers["Cache-Control"] = "no-store"
        return resp
    except UploadSessionError as e:
        return jsonify({"error": e.message}), e.status
    except Exception as e:
        app.logger.exception("Resumable upload commit failed for %s: %s", session_id, e)
        try:
            with _upload_requests_conn() as conn:
                conn.execute(
                    "UPDATE upload_sessions SET commit_error = ?, updated_at = ? WHERE session_id = ?",
                    (str(e)[:500], int(time.time()), session_id),
                )
        except Exception:
            pass
        return jsonify({"error": "Failed to save uploaded file"}), 500


@app.route("/api/upload-request/<request_id>/session/<session_id>", methods=["DELETE"])
def cancel_upload_request_session(request_id: str, session_id: str):
    try:
        with _upload_session_lock(session_id):
            session, info = _require_upload_session(request_id, session_id)
            if str(session.get("status") or "") == "committed":
                raise UploadSessionError(409, "Committed uploads cannot be canceled")
            try:
                temp_path = _upload_session_temp_path(info, session_id)
                os.remove(temp_path)
                try:
                    os.rmdir(os.path.dirname(temp_path))
                except OSError:
                    pass
            except FileNotFoundError:
                pass
            with _upload_requests_conn() as conn:
                conn.execute("DELETE FROM upload_sessions WHERE session_id = ?", (session_id,))
        try:
            os.remove(_upload_session_lock_path(session_id))
        except FileNotFoundError:
            pass
        resp = jsonify({"ok": True, "canceled": True})
        resp.headers["Cache-Control"] = "no-store"
        return resp
    except UploadSessionError as e:
        return jsonify({"error": e.message}), e.status


@app.route("/api/upload-request/<request_id>/upload", methods=["POST"])
def upload_request_upload(request_id: str):
    if not is_valid_upload_request_id(request_id):
        return jsonify({"error": "Invalid request ID"}), 400

    info = _get_upload_request(request_id)
    if not info:
        return jsonify({"error": "Not found"}), 404

    if _upload_request_is_disabled(info):
        return jsonify({"error": "Request disabled"}), 410

    if _upload_request_is_expired(info):
        return jsonify({"error": "Request expired"}), 410

    ip = _get_client_ip() or request.remote_addr or ""
    user_agent = request.headers.get("User-Agent")

    if info.get("password_protected"):
        token = request.headers.get("X-Session-Token") or request.args.get("token")
        if not _validate_upload_request_token(str(token or ""), request_id, client_ip=(ip or None)):
            return jsonify({"error": "Authentication required"}), 401

    files = []
    try:
        files = request.files.getlist("files") or request.files.getlist("file") or []
    except Exception:
        files = []

    if not files:
        return jsonify({"error": "No files uploaded"}), 400

    # Enforce max files per request.
    max_files = int(info.get("max_files") or 0)
    with _upload_requests_conn() as conn:
        existing_count = conn.execute(
            "SELECT COUNT(1) AS c FROM upload_files WHERE request_id = ?",
            (request_id,),
        ).fetchone()
        current_files = int(existing_count["c"] or 0) if existing_count else 0

    if max_files > 0 and current_files + len(files) > max_files:
        return jsonify({"error": f"Too many files (limit {max_files})"}), 400

    # Resolve filesystem destination.
    target_path = str(info.get("target_path") or "")
    safe_target = _safe_root_path(target_path)
    if not safe_target:
        return jsonify({"error": "Invalid target path"}), 500

    fs_target_dir = _robust_share_fs_path(source_path=safe_target)
    if not fs_target_dir:
        return jsonify({"error": "Target path is outside root"}), 500

    try:
        os.makedirs(fs_target_dir, exist_ok=True)
    except Exception:
        return jsonify({"error": "Failed to prepare target folder"}), 500

    if not os.access(fs_target_dir, os.W_OK):
        return jsonify({"error": "Target folder is not writable by the server"}), 403

    allowed_exts = set(info.get("allowed_exts") or [])
    overwrite = bool(info.get("overwrite"))

    max_file_size_bytes = int(info.get("max_file_size_bytes") or 0)
    hard_max_bytes = max(1, UPLOAD_REQUEST_HARD_MAX_FILE_MB) * 1024 * 1024
    if max_file_size_bytes <= 0:
        max_file_size_bytes = hard_max_bytes
    else:
        max_file_size_bytes = min(max_file_size_bytes, hard_max_bytes)

    now = int(time.time())
    results = []

    for f in files:
        original_name = _safe_upload_filename(getattr(f, "filename", None))
        if not original_name:
            return jsonify({"error": "Invalid filename"}), 400

        ext = _file_ext(original_name)
        if allowed_exts and ext not in allowed_exts:
            return jsonify({"error": f"File type not allowed: .{ext or ''}"}), 400

        dest_name = original_name
        if not overwrite:
            dest_name = _pick_unique_name(fs_target_dir, dest_name)

        dest_path_fs = os.path.join(fs_target_dir, dest_name)
        tmp_path = dest_path_fs + ".part"

        size = 0
        try:
            with open(tmp_path, "wb") as out:
                while True:
                    chunk = f.stream.read(UPLOAD_REQUEST_STREAM_CHUNK_SIZE)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_file_size_bytes:
                        raise ValueError("File too large")
                    out.write(chunk)
            os.replace(tmp_path, dest_path_fs)
        except ValueError:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass
            return jsonify({"error": f"File too large (max {max_file_size_bytes} bytes)"}), 413
        except Exception as e:
            app.logger.error("Upload failed for %s: %s", original_name, e)
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass
            return jsonify({"error": "Upload failed"}), 500

        content_type = None
        try:
            content_type = str(getattr(f, "content_type", None) or "") or None
        except Exception:
            content_type = None

        with _upload_requests_conn() as conn:
            conn.execute(
                """
                INSERT INTO upload_files (request_id, original_name, stored_name, size_bytes, content_type, client_ip, user_agent, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (request_id, original_name, dest_name, int(size), content_type, (ip or None), user_agent, now),
            )

        results.append({"original_name": original_name, "stored_name": dest_name, "size_bytes": int(size)})

    resp = jsonify({"ok": True, "request_id": request_id, "uploaded": results})
    resp.headers["Cache-Control"] = "no-store"

    try:
        base = PUBLIC_BASE_URL or request.host_url.rstrip("/")
    except Exception:
        base = PUBLIC_BASE_URL or ""

    _schedule_upload_webhook(
        "upload_request.uploaded",
        {
            "event_id": secrets.token_hex(16),
            "event_type": "upload_request.uploaded",
            "created_at": now,
            "request_id": request_id,
            "title": str(info.get("title") or ""),
            "dest_path": str(info.get("dest_path") or ""),
            "target_path": str(info.get("target_path") or ""),
            "upload_url": f"/upload/{request_id}",
            "upload_link": (f"{base}/upload/{request_id}" if base else f"/upload/{request_id}"),
            "uploaded": results,
            "uploaded_count": int(len(results)),
            "uploaded_bytes": int(sum(int(r.get("size_bytes") or 0) for r in results)),
            "client_ip": ip or None,
            "user_agent": user_agent or None,
        },
    )

    return resp


@app.route("/api/upload-request/<request_id>/share-back", methods=["POST"])
def upload_request_share_back(request_id: str):
    """Create (or rotate) a robust share for the Upload Request target folder."""
    if not is_valid_upload_request_id(request_id):
        return jsonify({"error": "Invalid request ID"}), 400

    info = _get_upload_request(request_id)
    if not info:
        return jsonify({"error": "Not found"}), 404

    if _upload_request_is_disabled(info):
        return jsonify({"error": "Request disabled"}), 410

    if _upload_request_is_expired(info):
        return jsonify({"error": "Request expired"}), 410

    if not bool(info.get("share_back_enabled")):
        return jsonify({"error": "Share back is not enabled for this request"}), 403

    ip = _get_client_ip() or request.remote_addr or ""
    user_agent = request.headers.get("User-Agent")

    if not _check_rate_limit(f"uploadreqshare:{request_id}:{ip}", max_requests=6, window_seconds=60):
        return jsonify({"error": "Too many attempts"}), 429

    if info.get("password_protected"):
        token = request.headers.get("X-Session-Token") or request.args.get("token")
        if not _validate_upload_request_token(str(token or ""), request_id, client_ip=(ip or None)):
            return jsonify({"error": "Authentication required"}), 401

    with _upload_requests_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(1) AS c FROM upload_files WHERE request_id = ?",
            (request_id,),
        ).fetchone()
        uploaded_count = int(row["c"] or 0) if row else 0

    if uploaded_count <= 0:
        return jsonify({"error": "No uploaded files yet"}), 400

    target_path = str(info.get("target_path") or "")
    safe_target = _safe_root_path(target_path)
    if not safe_target:
        return jsonify({"error": "Invalid target path"}), 500

    fs_target_dir = _robust_share_fs_path(source_path=safe_target)
    if not fs_target_dir or not os.path.isdir(fs_target_dir):
        return jsonify({"error": "Target folder not found"}), 404

    old_share_id = info.get("share_back_share_id")
    if old_share_id and is_valid_robust_share_id(str(old_share_id)):
        try:
            with _robust_shares_conn() as conn:
                conn.execute("DELETE FROM robust_shares WHERE share_id = ?", (str(old_share_id),))
        except Exception as e:
            app.logger.warning("Failed to delete previous share %s for %s: %s", old_share_id, request_id, e)

    share_id = _generate_robust_share_id()
    now = int(time.time())

    expires_at = None
    if info.get("expires_at") is not None:
        try:
            expires_at = int(info.get("expires_at") or 0) or None
        except Exception:
            expires_at = None

    title = _sanitize_title(str(info.get("title") or ""))
    if title:
        title = f"{title} (uploads)"[:MAX_TITLE_LENGTH]
    else:
        base = os.path.basename(safe_target.rstrip("/"))[:MAX_TITLE_LENGTH] or "Uploads"
        title = f"{base} (uploads)"[:MAX_TITLE_LENGTH]

    with _robust_shares_conn() as conn:
        conn.execute(
            """
            INSERT INTO robust_shares (share_id, source_path, share_type, title, password_hash, created_at, expires_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (share_id, safe_target, "folder", title, None, now, expires_at, f"upload_request:{request_id}"),
        )

    try:
        file_count, total_size = _scan_and_store_files(share_id, safe_target, "folder")
    except Exception as e:
        app.logger.warning("Failed to scan files for share-back %s (%s): %s", share_id, request_id, e)
        file_count, total_size = 0, 0

    with _upload_requests_conn() as conn:
        conn.execute(
            "UPDATE upload_requests SET share_back_share_id = ?, share_back_created_at = ? WHERE request_id = ?",
            (share_id, now, request_id),
        )

    share_url = f"/share/{share_id}"

    try:
        base_url = PUBLIC_BASE_URL or request.host_url.rstrip("/")
    except Exception:
        base_url = PUBLIC_BASE_URL or ""

    _schedule_upload_webhook(
        "upload_request.share_created",
        {
            "event_id": secrets.token_hex(16),
            "event_type": "upload_request.share_created",
            "created_at": now,
            "request_id": request_id,
            "share_id": share_id,
            "share_url": share_url,
            "share_link": (f"{base_url}{share_url}" if base_url else share_url),
            "expires_at": expires_at,
            "file_count": int(file_count or 0),
            "total_size": int(total_size or 0),
            "client_ip": ip or None,
            "user_agent": user_agent or None,
        },
    )

    resp = jsonify(
        {
            "ok": True,
            "request_id": request_id,
            "share_id": share_id,
            "share_url": share_url,
            "share_link": (f"{base_url}{share_url}" if base_url else share_url),
            "expires_at": expires_at,
            "file_count": int(file_count or 0),
            "total_size": int(total_size or 0),
        }
    )
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/health")
def health_check():
    return jsonify({"status": "healthy"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
