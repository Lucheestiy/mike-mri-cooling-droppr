#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: smoke_admin_storage.sh

Runs a local container-side smoke test for the admin storage/cache endpoints.
Skips cleanly when Docker Compose or media-server is unavailable.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "skip: docker is not available"
  exit 0
fi

if ! docker compose ps media-server >/dev/null 2>&1; then
  echo "skip: media-server is not available in this compose project"
  exit 0
fi

docker compose exec -T media-server python - <<'PY'
import os
import shutil
import tempfile
import time

import app as droppr_app

client = droppr_app.app.test_client()

unauth = client.get("/api/droppr/storage")
if unauth.status_code != 401:
    raise SystemExit(f"FAIL: unauthenticated storage returned {unauth.status_code}, expected 401")

bad_clear = client.post("/api/droppr/storage/clear", json={"target": "not-a-cache"})
if bad_clear.status_code != 401:
    raise SystemExit(f"FAIL: unauthenticated storage clear returned {bad_clear.status_code}, expected 401")

droppr_app._get_auth_token = lambda: "test-admin-token"
droppr_app._validate_filebrowser_admin = lambda token: None

old_thumb = droppr_app.CACHE_DIR
old_proxy = droppr_app.PROXY_CACHE_DIR
tmp = tempfile.mkdtemp(prefix="droppr-storage-smoke-")
try:
    droppr_app.CACHE_DIR = os.path.join(tmp, "thumb-cache")
    droppr_app.PROXY_CACHE_DIR = os.path.join(tmp, "proxy-cache")
    os.makedirs(droppr_app.CACHE_DIR, exist_ok=True)
    os.makedirs(droppr_app.PROXY_CACHE_DIR, exist_ok=True)

    thumb_file = os.path.join(droppr_app.CACHE_DIR, "thumb.jpg")
    proxy_file = os.path.join(droppr_app.PROXY_CACHE_DIR, "proxy.mp4")
    lock_file = os.path.join(droppr_app.PROXY_CACHE_DIR, "proxy.mp4.lock")
    recent_file = os.path.join(droppr_app.CACHE_DIR, "recent.jpg")

    for path, body in (
        (thumb_file, b"thumb"),
        (proxy_file, b"proxy"),
        (lock_file, b"lock"),
        (recent_file, b"recent"),
    ):
        with open(path, "wb") as fh:
            fh.write(body)

    old_ts = int(time.time()) - 120
    os.utime(thumb_file, (old_ts, old_ts))
    os.utime(proxy_file, (old_ts, old_ts))
    os.utime(lock_file, (old_ts, old_ts))

    stats_resp = client.get("/api/droppr/storage")
    if stats_resp.status_code != 200:
        raise SystemExit(f"FAIL: storage stats returned {stats_resp.status_code}: {stats_resp.get_data(as_text=True)[:200]}")
    if stats_resp.headers.get("Cache-Control") != "no-store":
        raise SystemExit("FAIL: storage stats missing Cache-Control: no-store")

    stats = (stats_resp.get_json(silent=True) or {}).get("storage") or {}
    targets = stats.get("targets") or {}
    if "thumbnails" not in targets or "video_proxy" not in targets:
        raise SystemExit("FAIL: storage stats missing expected cache targets")
    if int(stats.get("total_cache_bytes") or 0) <= 0:
        raise SystemExit("FAIL: storage stats did not count test cache bytes")

    invalid = client.post("/api/droppr/storage/clear", json={"target": "bad"})
    if invalid.status_code != 400:
        raise SystemExit(f"FAIL: invalid storage target returned {invalid.status_code}, expected 400")

    clear_recent = client.post(
        "/api/droppr/storage/clear",
        json={"target": "thumbnails", "min_age_seconds": 60},
    )
    if clear_recent.status_code != 200:
        raise SystemExit(f"FAIL: clear thumbnails returned {clear_recent.status_code}: {clear_recent.get_data(as_text=True)[:200]}")
    if os.path.exists(thumb_file):
        raise SystemExit("FAIL: old thumbnail cache file was not deleted")
    if not os.path.exists(recent_file):
        raise SystemExit("FAIL: recent thumbnail cache file was not skipped")

    dry_run = client.post(
        "/api/droppr/storage/clear",
        json={"target": "video_proxy", "min_age_seconds": 0, "dry_run": True},
    )
    if dry_run.status_code != 200:
        raise SystemExit(f"FAIL: dry-run video clear returned {dry_run.status_code}")
    if not os.path.exists(proxy_file):
        raise SystemExit("FAIL: dry-run deleted proxy cache file")

    clear_proxy = client.post(
        "/api/droppr/storage/clear",
        json={"target": "video_proxy", "min_age_seconds": 0},
    )
    if clear_proxy.status_code != 200:
        raise SystemExit(f"FAIL: clear video proxy returned {clear_proxy.status_code}: {clear_proxy.get_data(as_text=True)[:200]}")
    if os.path.exists(proxy_file):
        raise SystemExit("FAIL: old proxy cache file was not deleted")
    if not os.path.exists(lock_file):
        raise SystemExit("FAIL: lock file should be skipped")

    print("PASS: admin storage smoke passed")
finally:
    droppr_app.CACHE_DIR = old_thumb
    droppr_app.PROXY_CACHE_DIR = old_proxy
    shutil.rmtree(tmp, ignore_errors=True)
PY
