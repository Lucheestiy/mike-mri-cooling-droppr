#!/usr/bin/env bash
set -euo pipefail

share_id=""

usage() {
  cat <<'EOF'
Usage: smoke_robust_share_admin.sh [--share-id RS_ID]

Runs a local container-side smoke test for admin Robust Share maintenance
endpoints. Skips cleanly when Docker Compose or robust-share data is unavailable.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --share-id)
      share_id="${2:?missing value for --share-id}"
      shift 2
      ;;
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

docker compose exec -T media-server python - "${share_id}" <<'PY'
import json
import sqlite3
import sys

import app as droppr_app

share_id = (sys.argv[1] or "").strip()

if not share_id:
    with sqlite3.connect("/database/droppr-robust-shares.sqlite3") as conn:
        row = conn.execute(
            "SELECT share_id FROM robust_shares ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
    if not row:
        print("skip: no robust shares available")
        raise SystemExit(0)
    share_id = str(row[0])

client = droppr_app.app.test_client()

bad = client.post("/api/robust-share/BAD/refresh")
if bad.status_code != 400:
    raise SystemExit(f"FAIL: invalid robust share id returned {bad.status_code}, expected 400")

unauth = client.post(f"/api/robust-share/{share_id}/refresh")
if unauth.status_code != 401:
    raise SystemExit(f"FAIL: unauthenticated refresh returned {unauth.status_code}, expected 401")

droppr_app._get_auth_token = lambda: "test-admin-token"
droppr_app._validate_filebrowser_admin = lambda token: None

before = droppr_app._get_robust_share_info(share_id)
if not before:
    print(f"skip: robust share not found: {share_id}")
    raise SystemExit(0)

refresh = client.post(f"/api/robust-share/{share_id}/refresh")
if refresh.status_code == 404 and "source" in refresh.get_data(as_text=True).lower():
    print(f"skip: robust share source is not present: {share_id}")
    raise SystemExit(0)
if refresh.status_code != 200:
    raise SystemExit(f"FAIL: refresh returned {refresh.status_code}: {refresh.get_data(as_text=True)[:200]}")

if refresh.headers.get("Cache-Control") != "no-store":
    raise SystemExit("FAIL: refresh response is missing Cache-Control: no-store")

data = refresh.get_json(silent=True) or {}
share = data.get("share") or {}
body = json.dumps(data, sort_keys=True)

if not data.get("refreshed"):
    raise SystemExit("FAIL: refresh response did not report refreshed=true")
if share.get("share_id") != share_id:
    raise SystemExit("FAIL: refresh response share_id mismatch")
if "password_hash" in body:
    raise SystemExit("FAIL: refresh response leaked password_hash")

files = droppr_app._get_robust_share_files(share_id)
expected_count = len(files)
expected_size = sum(int(f.get("size") or 0) for f in files)
if int(share.get("file_count") or 0) != expected_count:
    raise SystemExit(f"FAIL: refresh file_count mismatch: got={share.get('file_count')} expected={expected_count}")
if int(share.get("total_size") or 0) != expected_size:
    raise SystemExit(f"FAIL: refresh total_size mismatch: got={share.get('total_size')} expected={expected_size}")

print(f"PASS: robust share admin smoke passed ({share_id})")
PY
