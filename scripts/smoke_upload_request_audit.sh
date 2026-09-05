#!/usr/bin/env bash
set -euo pipefail

request_id=""

usage() {
  cat <<'EOF'
Usage: smoke_upload_request_audit.sh [--request-id UR_ID]

Runs a local container-side smoke test for the admin upload-request detail and
CSV export endpoints. Skips cleanly when Docker Compose or upload-request data
is unavailable.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --request-id)
      request_id="${2:?missing value for --request-id}"
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

docker compose exec -T media-server python - "${request_id}" <<'PY'
import csv
import io
import json
import sqlite3
import sys

import app as droppr_app

request_id = (sys.argv[1] or "").strip()

if not request_id:
    with sqlite3.connect("/database/droppr-upload-requests.sqlite3") as conn:
        row = conn.execute(
            "SELECT request_id FROM upload_requests ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
    if not row:
        print("skip: no upload requests available")
        raise SystemExit(0)
    request_id = str(row[0])

client = droppr_app.app.test_client()

bad = client.get("/api/upload-request/BAD/detail")
if bad.status_code != 400:
    raise SystemExit(f"FAIL: invalid request id returned {bad.status_code}, expected 400")

unauth = client.get(f"/api/upload-request/{request_id}/export.csv")
if unauth.status_code != 401:
    raise SystemExit(f"FAIL: unauthenticated export returned {unauth.status_code}, expected 401")

droppr_app._get_auth_token = lambda: "test-admin-token"
droppr_app._validate_filebrowser_admin = lambda token: None

detail_resp = client.get(f"/api/upload-request/{request_id}/detail?files_limit=3")
if detail_resp.status_code != 200:
    raise SystemExit(f"FAIL: detail returned {detail_resp.status_code}: {detail_resp.get_data(as_text=True)[:200]}")

detail_data = detail_resp.get_json(silent=True) or {}
detail = detail_data.get("request") or {}
detail_body = json.dumps(detail_data, sort_keys=True)

for forbidden in ("password_hash", "client_ip", "user_agent"):
    if forbidden in detail_body:
        raise SystemExit(f"FAIL: detail leaked forbidden field: {forbidden}")

if detail.get("request_id") != request_id:
    raise SystemExit("FAIL: detail request_id mismatch")

if int(detail.get("files_returned") or 0) > 3:
    raise SystemExit("FAIL: detail ignored files_limit")

if detail_resp.headers.get("Cache-Control") != "no-store":
    raise SystemExit("FAIL: detail response is missing Cache-Control: no-store")

export_resp = client.get(f"/api/upload-request/{request_id}/export.csv")
if export_resp.status_code != 200:
    raise SystemExit(f"FAIL: export returned {export_resp.status_code}: {export_resp.get_data(as_text=True)[:200]}")

export_body = export_resp.get_data(as_text=True)
for forbidden in ("password_hash", "client_ip", "user_agent"):
    if forbidden in export_body:
        raise SystemExit(f"FAIL: export leaked forbidden field: {forbidden}")

if export_resp.headers.get("Cache-Control") != "no-store":
    raise SystemExit("FAIL: export response is missing Cache-Control: no-store")
if ".csv" not in (export_resp.headers.get("Content-Disposition") or ""):
    raise SystemExit("FAIL: export response is missing CSV Content-Disposition")

rows = list(csv.reader(io.StringIO(export_body)))
expected_header = [
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
if not rows or rows[0] != expected_header:
    raise SystemExit(f"FAIL: unexpected CSV header: {rows[0] if rows else '<empty>'}")

if not droppr_app._csv_row(["=cmd"]).startswith("'=cmd"):
    raise SystemExit("FAIL: CSV formula guard did not prefix formula-like cells")

print(f"PASS: upload request audit smoke passed ({request_id})")
PY
