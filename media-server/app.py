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
import os
import re
import sqlite3
import threading
import time
import subprocess
import shutil
import hashlib
from contextlib import contextmanager
from urllib.parse import quote

import requests
from flask import Flask, Response, jsonify, redirect, request, stream_with_context

app = Flask(__name__)

# FileBrowser API base URL (internal docker network)
FILEBROWSER_BASE_URL = os.environ.get("DROPPR_FILEBROWSER_BASE_URL", "http://droppr-app:80")
FILEBROWSER_PUBLIC_DL_API = f"{FILEBROWSER_BASE_URL}/api/public/dl"
FILEBROWSER_PUBLIC_SHARE_API = f"{FILEBROWSER_BASE_URL}/api/public/share"
FILEBROWSER_SHARES_API = f"{FILEBROWSER_BASE_URL}/api/shares"

SHARE_HASH_RE = re.compile(r"^[A-Za-z0-9_-]+$")
MAX_SHARE_HASH_LENGTH = 64  # Prevent DOS via extremely long hashes

# Gallery file-list caching (in-memory, per gunicorn worker)
DEFAULT_CACHE_TTL_SECONDS = int(os.environ.get("DROPPR_SHARE_CACHE_TTL_SECONDS", "3600"))
MAX_CACHE_SIZE = 1000  # Max number of shares to cache
_share_cache_lock = threading.Lock()
_share_files_cache: dict[str, tuple[float, list[dict]]] = {}

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

_last_retention_sweep_at: float = 0.0
_analytics_db_ready: bool = False


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


def _infer_gallery_type(item: dict, extension: str) -> str:
    raw_type = (item.get("type") or "").strip().lower()
    if raw_type in {"image", "video"}:
        return raw_type
    if extension in IMAGE_EXTS:
        return "image"
    if extension in VIDEO_EXTS:
        return "video"
    return "file"


def _build_folder_share_file_list(share_hash: str, root: dict) -> list[dict]:
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

        data = _fetch_public_share_json(share_hash, subpath=dir_path)
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
                "inline_url": f"/api/public/dl/{share_hash}/{quote(rel_path, safe='/')}?inline=true",
                "download_url": f"/api/share/{share_hash}/file/{quote(rel_path, safe='/')}?download=1",
            }
        )

    return result


def _build_file_share_file_list(share_hash: str, meta: dict) -> list[dict]:
    raw_path = meta.get("path")
    name = meta.get("name")
    if not isinstance(name, str) or not name:
        if isinstance(raw_path, str) and raw_path:
            name = os.path.basename(raw_path)
        else:
            name = share_hash

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
            "inline_url": f"/api/public/file/{share_hash}?inline=true",
            "download_url": f"/api/share/{share_hash}/download",
        }
    ]


def _get_share_files(share_hash: str, *, force_refresh: bool, max_age_seconds: int) -> list[dict] | None:
    now = time.time()
    if not force_refresh:
        with _share_cache_lock:
            cached = _share_files_cache.get(share_hash)
            if cached and (now - cached[0]) < max_age_seconds:
                return cached[1]

    data = _fetch_public_share_json(share_hash)
    if not data:
        return None

    if isinstance(data.get("items"), list):
        files = _build_folder_share_file_list(share_hash, data)
    else:
        files = _build_file_share_file_list(share_hash, data)

    with _share_cache_lock:
        if len(_share_files_cache) >= MAX_CACHE_SIZE:
            # Simple eviction strategy: clear the whole cache if it gets too big.
            # A more sophisticated LRU is possible but likely overkill for this scale.
            _share_files_cache.clear()
        _share_files_cache[share_hash] = (now, files)

    return files


@app.route("/api/share/<share_hash>/files")
def list_share_files(share_hash: str):
    if not is_valid_share_hash(share_hash):
        return jsonify({"error": "Invalid share hash"}), 400

    force_refresh = parse_bool(request.args.get("refresh") or request.args.get("force"))
    max_age_param = request.args.get("max_age") or request.args.get("maxAge")
    max_age_seconds = DEFAULT_CACHE_TTL_SECONDS
    if max_age_param is not None:
        try:
            max_age_seconds = max(0, int(max_age_param))
        except (TypeError, ValueError):
            max_age_seconds = DEFAULT_CACHE_TTL_SECONDS

    files = _get_share_files(share_hash, force_refresh=force_refresh, max_age_seconds=max_age_seconds)
    if files is None:
        return jsonify({"error": "Share not found"}), 404

    resp = jsonify(files)
    resp.headers["Cache-Control"] = "no-store"
    _log_event("gallery_view", share_hash)
    return resp


@app.route("/api/share/<share_hash>/file/<path:filename>")
def serve_file(share_hash: str, filename: str):
    if not is_valid_share_hash(share_hash):
        return "Invalid share hash", 400

    filename = filename or ""
    safe = _safe_rel_path(filename)
    if not safe:
        return "Invalid filename", 400

    is_download = parse_bool(request.args.get("download") or request.args.get("dl"))
    if is_download:
        _log_event("file_download", share_hash, file_path=safe)

    encoded = quote(safe, safe="/")
    if is_download:
        return redirect(f"/api/public/dl/{share_hash}/{encoded}?download=1", code=302)
    return redirect(f"/api/public/dl/{share_hash}/{encoded}?inline=true", code=302)


CACHE_DIR = os.environ.get("DROPPR_CACHE_DIR", "/tmp/thumbnails")
os.makedirs(CACHE_DIR, exist_ok=True)

THUMB_MAX_WIDTH = int(os.environ.get("DROPPR_THUMB_MAX_WIDTH", "800"))
THUMB_JPEG_QUALITY = int(os.environ.get("DROPPR_THUMB_JPEG_QUALITY", "6"))
THUMB_FFMPEG_TIMEOUT_SECONDS = int(os.environ.get("DROPPR_THUMB_FFMPEG_TIMEOUT_SECONDS", "25"))
THUMB_MAX_CONCURRENCY = int(os.environ.get("DROPPR_THUMB_MAX_CONCURRENCY", "2"))
_thumb_sema = threading.BoundedSemaphore(max(1, THUMB_MAX_CONCURRENCY))

PROXY_CACHE_DIR = os.environ.get("DROPPR_PROXY_CACHE_DIR", "/tmp/proxy-cache")
os.makedirs(PROXY_CACHE_DIR, exist_ok=True)

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


def _proxy_cache_key(*, share_hash: str, file_path: str, size: int) -> str:
    # Cache key is stable across requests and invalidates when the source size or encoding profile changes.
    key = f"proxy:{PROXY_PROFILE_VERSION}:{PROXY_MAX_DIMENSION}:{PROXY_CRF}:{PROXY_H264_PRESET}:{share_hash}:{file_path}:{size}"
    return hashlib.sha256(key.encode()).hexdigest()


def _hd_cache_key(*, share_hash: str, file_path: str, size: int) -> str:
    key = f"hd:{HD_PROFILE_VERSION}:{HD_MAX_DIMENSION}:{HD_CRF}:{HD_H264_PRESET}:{share_hash}:{file_path}:{size}"
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


def _ensure_fast_proxy_mp4(*, share_hash: str, file_path: str, size: int) -> tuple[str, str, str, int | None]:
    cache_key = _proxy_cache_key(share_hash=share_hash, file_path=file_path, size=size)
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


def _ensure_hd_mp4(*, share_hash: str, file_path: str, size: int) -> tuple[str, str, str, int | None]:
    cache_key = _hd_cache_key(share_hash=share_hash, file_path=file_path, size=size)
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

    filename = filename or ""
    safe = _safe_rel_path(filename)
    if not safe:
        return "Invalid filename", 400

    ext = os.path.splitext(safe)[1].lstrip(".").lower()
    is_video = ext in VIDEO_EXTS
    is_image = ext in IMAGE_EXTS
    if not is_video and not is_image:
        return "Unsupported preview type", 415

    cache_path = _get_cache_path(share_hash, safe)
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
                src_url = f"{FILEBROWSER_PUBLIC_DL_API}/{share_hash}/{quote(safe, safe='/')}?inline=true"

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

    filename = filename or ""
    safe = _safe_rel_path(filename)
    if not safe:
        return "Invalid filename", 400

    ext = os.path.splitext(safe)[1].lstrip(".").lower()
    if ext not in VIDEO_EXTS:
        return "Unsupported proxy type", 415

    # Resolve file size to get a stable cache key (and invalidate on overwrite).
    files = _get_share_files(share_hash, force_refresh=False, max_age_seconds=DEFAULT_CACHE_TTL_SECONDS) or []
    match = next((f for f in files if isinstance(f, dict) and f.get("path") == safe), None)
    if not match:
        files = _get_share_files(share_hash, force_refresh=True, max_age_seconds=0) or []
        match = next((f for f in files if isinstance(f, dict) and f.get("path") == safe), None)

    if not match:
        return "File not found", 404

    try:
        _, _, public_url, _ = _ensure_fast_proxy_mp4(share_hash=share_hash, file_path=safe, size=int(match.get("size") or 0))
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

    filename = filename or ""
    safe = _safe_rel_path(filename)
    if not safe:
        return jsonify({"error": "Invalid filename"}), 400

    ext = os.path.splitext(safe)[1].lstrip(".").lower()
    if ext not in VIDEO_EXTS:
        return jsonify({"error": "Unsupported video type"}), 415

    files = _get_share_files(share_hash, force_refresh=False, max_age_seconds=DEFAULT_CACHE_TTL_SECONDS) or []
    match = next((f for f in files if isinstance(f, dict) and f.get("path") == safe), None)
    if not match:
        files = _get_share_files(share_hash, force_refresh=True, max_age_seconds=0) or []
        match = next((f for f in files if isinstance(f, dict) and f.get("path") == safe), None)

    if not match:
        return jsonify({"error": "File not found"}), 404

    original_url = match.get("inline_url")
    original_size = int(match.get("size") or 0)

    proxy_key = _proxy_cache_key(share_hash=share_hash, file_path=safe, size=original_size)
    proxy_path = os.path.join(PROXY_CACHE_DIR, f"{proxy_key}.mp4")
    proxy_url = f"/api/proxy-cache/{proxy_key}.mp4"

    proxy_ready = os.path.exists(proxy_path)
    proxy_size = os.path.getsize(proxy_path) if proxy_ready else None

    hd_key = _hd_cache_key(share_hash=share_hash, file_path=safe, size=original_size)
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
            share_hash=share_hash,
            file_path=safe,
            size=original_size,
        )

    if "hd" in prepare_targets and not hd_ready:
        prepare_started["hd"] = _spawn_background(
            f"hd:{hd_key}",
            _ensure_hd_mp4,
            share_hash=share_hash,
            file_path=safe,
            size=original_size,
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


@app.route("/api/share/<share_hash>/download")
def download_all(share_hash: str):
    if not is_valid_share_hash(share_hash):
        return "Invalid share hash", 400

    try:
        req_url = f"{FILEBROWSER_PUBLIC_DL_API}/{share_hash}?download=1"
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


@app.route("/health")
def health_check():
    return jsonify({"status": "healthy"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
