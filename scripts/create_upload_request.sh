#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
DOTENV_FILE="${ROOT_DIR}/.env"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Create a Droppr Upload Request link using the supported API.

Usage:
  create_upload_request.sh --path <folder> [options]

Required:
  --path <folder>                 Destination folder in Droppr (example: /incoming)

Auth (choose one):
  --token <x_auth_token>          Existing File Browser token
  --user <username> --password <password>
                                  If password is missing, prompts in TTY.

Options:
  --base-url <url>                Droppr base URL (default: DROPPR_BASE_URL or https://droppr.coolmri.com)
  --title <text>                  Request title (default: File Upload Request)
  --request-password <password>   Password required on the upload page
  --expires-hours <n>             Expiration in hours, 0 = never (default: 168)
  --max-files <n>                 Max files per request, 0 = unlimited (default: 1)
  --max-file-size-mb <n>          Max single file size in MB, 0 = unlimited (default: 0)
  --allowed-exts <csv>            Allowed extensions CSV (example: jpg,png,mp4)
  --overwrite                     Allow overwrite (default)
  --no-overwrite                  Disallow overwrite
  --create-subfolder              Create isolated upload subfolder (default)
  --no-create-subfolder           Upload directly into destination folder
  --share-back                    Enable share-back link generation (default)
  --no-share-back                 Disable share-back link generation
  --json                          Print create response JSON only
  --no-verify                     Skip public info verification call
  -h, --help                      Show help

Environment defaults:
  DROPPR_BASE_URL
  DROPPR_AUTH_TOKEN
  DROPPR_USER
  DROPPR_PASSWORD
EOF
}

dotenv_get() {
  local key="$1"
  local file="$2"
  local line
  [[ -f "$file" ]] || return 1
  line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  line="${line#*=}"
  line="${line%$'\r'}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line"
}

is_non_negative_int() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

BASE_URL="${DROPPR_BASE_URL:-}"
AUTH_TOKEN="${DROPPR_AUTH_TOKEN:-}"
USERNAME="${DROPPR_USER:-admin}"
PASSWORD="${DROPPR_PASSWORD:-}"

DEST_PATH=""
TITLE="File Upload Request"
REQUEST_PASSWORD=""
EXPIRES_HOURS="168"
MAX_FILES="1"
MAX_FILE_SIZE_MB="0"
ALLOWED_EXTS=""
OVERWRITE="true"
CREATE_SUBFOLDER="true"
SHARE_BACK="true"
JSON_ONLY="false"
VERIFY_INFO="true"

if [[ -z "$BASE_URL" ]]; then
  BASE_URL="https://droppr.coolmri.com"
fi

if [[ -f "$DOTENV_FILE" ]]; then
  if [[ -z "$AUTH_TOKEN" ]]; then
    AUTH_TOKEN="$(dotenv_get DROPPR_AUTH_TOKEN "$DOTENV_FILE" || true)"
  fi
  if [[ "$USERNAME" == "admin" ]]; then
    USERNAME="$(dotenv_get DROPPR_USER "$DOTENV_FILE" || echo "admin")"
  fi
  if [[ -z "$PASSWORD" ]]; then
    PASSWORD="$(dotenv_get DROPPR_PASSWORD "$DOTENV_FILE" || true)"
  fi
  if [[ "${DROPPR_BASE_URL:-}" == "" ]]; then
    BASE_URL="$(dotenv_get DROPPR_BASE_URL "$DOTENV_FILE" || echo "$BASE_URL")"
  fi
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path|--dest-path)
      DEST_PATH="${2:-}"
      shift 2
      ;;
    --base-url)
      BASE_URL="${2:-}"
      shift 2
      ;;
    --token)
      AUTH_TOKEN="${2:-}"
      shift 2
      ;;
    --user)
      USERNAME="${2:-}"
      shift 2
      ;;
    --password)
      PASSWORD="${2:-}"
      shift 2
      ;;
    --title)
      TITLE="${2:-}"
      shift 2
      ;;
    --request-password)
      REQUEST_PASSWORD="${2:-}"
      shift 2
      ;;
    --expires-hours)
      EXPIRES_HOURS="${2:-}"
      shift 2
      ;;
    --max-files)
      MAX_FILES="${2:-}"
      shift 2
      ;;
    --max-file-size-mb)
      MAX_FILE_SIZE_MB="${2:-}"
      shift 2
      ;;
    --allowed-exts)
      ALLOWED_EXTS="${2:-}"
      shift 2
      ;;
    --overwrite)
      OVERWRITE="true"
      shift
      ;;
    --no-overwrite)
      OVERWRITE="false"
      shift
      ;;
    --create-subfolder)
      CREATE_SUBFOLDER="true"
      shift
      ;;
    --no-create-subfolder)
      CREATE_SUBFOLDER="false"
      shift
      ;;
    --share-back)
      SHARE_BACK="true"
      shift
      ;;
    --no-share-back)
      SHARE_BACK="false"
      shift
      ;;
    --json)
      JSON_ONLY="true"
      shift
      ;;
    --no-verify)
      VERIFY_INFO="false"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

BASE_URL="${BASE_URL%/}"
[[ -n "$DEST_PATH" ]] || die "Missing --path"
[[ "$DEST_PATH" == /* ]] || die "--path must start with '/'"
[[ "$DEST_PATH" != "/" ]] || die "--path cannot be root '/'"
[[ -n "$BASE_URL" ]] || die "Invalid --base-url"
is_non_negative_int "$EXPIRES_HOURS" || die "--expires-hours must be a non-negative integer"
is_non_negative_int "$MAX_FILES" || die "--max-files must be a non-negative integer"
is_non_negative_int "$MAX_FILE_SIZE_MB" || die "--max-file-size-mb must be a non-negative integer"
[[ -n "$USERNAME" ]] || die "--user cannot be empty"

if [[ "$SHARE_BACK" == "true" && "$CREATE_SUBFOLDER" != "true" ]]; then
  die "--share-back requires --create-subfolder"
fi

if [[ -z "$AUTH_TOKEN" ]]; then
  if [[ -z "$PASSWORD" && -t 0 ]]; then
    read -r -s -p "Droppr password for ${USERNAME}: " PASSWORD
    echo
  fi
  [[ -n "$PASSWORD" ]] || die "Missing auth. Use --token or provide --user/--password."

  login_payload="$(python3 - <<'PY' "$USERNAME" "$PASSWORD"
import json
import sys
print(json.dumps({"username": sys.argv[1], "password": sys.argv[2]}, separators=(",", ":")))
PY
)"

  login_response="$(curl -sS --show-error \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/api/login" \
    -d "${login_payload}")"

  AUTH_TOKEN="$(python3 - <<'PY' "$login_response"
import json
import sys

raw = sys.argv[1].strip()
if not raw:
    raise SystemExit("empty login response")

token = None
if raw.startswith("{"):
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        obj = None
    if isinstance(obj, dict):
        for key in ("token", "jwt", "auth", "access_token"):
            val = obj.get(key)
            if isinstance(val, str) and val.strip():
                token = val.strip()
                break
        if token is None and isinstance(obj.get("data"), dict):
            nested = obj["data"]
            for key in ("token", "jwt", "auth", "access_token"):
                val = nested.get(key)
                if isinstance(val, str) and val.strip():
                    token = val.strip()
                    break
elif raw.startswith('"') and raw.endswith('"'):
    try:
        token = json.loads(raw)
    except json.JSONDecodeError:
        token = raw.strip('"')
else:
    token = raw

if not isinstance(token, str) or not token.strip():
    raise SystemExit("failed to parse auth token from login response")
print(token.strip())
PY
)"
fi

[[ -n "$AUTH_TOKEN" ]] || die "Auth token is empty"

create_payload="$(python3 - <<'PY' \
  "$DEST_PATH" "$TITLE" "$REQUEST_PASSWORD" "$EXPIRES_HOURS" "$MAX_FILES" "$MAX_FILE_SIZE_MB" \
  "$ALLOWED_EXTS" "$OVERWRITE" "$CREATE_SUBFOLDER" "$SHARE_BACK"
import json
import sys

dest_path = sys.argv[1]
title = sys.argv[2]
request_password = sys.argv[3]
expires_hours = int(sys.argv[4])
max_files = int(sys.argv[5])
max_file_size_mb = int(sys.argv[6])
allowed_raw = sys.argv[7]
overwrite = sys.argv[8].lower() == "true"
create_subfolder = sys.argv[9].lower() == "true"
share_back = sys.argv[10].lower() == "true"

allowed_exts = []
for part in allowed_raw.split(","):
    ext = part.strip().lower().lstrip(".")
    if not ext:
        continue
    if ext not in allowed_exts:
        allowed_exts.append(ext)

payload = {
    "path": dest_path,
    "title": title,
    "password": request_password,
    "expires_hours": expires_hours,
    "max_files": max_files,
    "max_file_size_mb": max_file_size_mb,
    "allowed_exts": allowed_exts,
    "overwrite": overwrite,
    "create_subfolder": create_subfolder,
    "share_back": share_back,
}
print(json.dumps(payload, separators=(",", ":")))
PY
)"

create_response="$(
  curl -sS --show-error \
    -H "X-Auth: ${AUTH_TOKEN}" \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/api/upload-request/create" \
    -d "${create_payload}" \
    -w $'\n%{http_code}'
)"

create_code="${create_response##*$'\n'}"
create_body="${create_response%$'\n'*}"
if ! [[ "$create_code" =~ ^[0-9]{3}$ ]]; then
  die "Unexpected create response status: ${create_code}"
fi
if [[ "$create_code" -lt 200 || "$create_code" -ge 300 ]]; then
  echo "$create_body" >&2
  die "Upload request create failed with HTTP ${create_code}"
fi

if [[ "$JSON_ONLY" == "true" ]]; then
  printf '%s\n' "$create_body"
  exit 0
fi

parsed_fields="$(
python3 - <<'PY' "$create_body" "$BASE_URL"
import json
import sys

body = json.loads(sys.argv[1])
base = sys.argv[2].rstrip("/")

request_id = str(body.get("request_id") or "").strip()
upload_url = str(body.get("upload_url") or "").strip()
target_path = str(body.get("target_path") or "").strip()
expires_at = body.get("expires_at")
if not request_id or not upload_url:
    raise SystemExit("missing request_id/upload_url in create response")

if upload_url.startswith("http://") or upload_url.startswith("https://"):
    upload_link = upload_url
else:
    upload_link = f"{base}/{upload_url.lstrip('/')}"

expires_out = ""
if isinstance(expires_at, int):
    expires_out = str(expires_at)

print("\t".join([request_id, upload_url, upload_link, target_path, expires_out]))
PY
)"

IFS=$'\t' read -r request_id upload_url upload_link target_path expires_at <<< "$parsed_fields"

verify_status="skipped"
if [[ "$VERIFY_INFO" == "true" ]]; then
  verify_response="$(
    curl -sS --show-error \
      -X GET "${BASE_URL}/api/upload-request/${request_id}/info" \
      -w $'\n%{http_code}'
  )"
  verify_code="${verify_response##*$'\n'}"
  if [[ "$verify_code" == "200" ]]; then
    verify_status="ok"
  else
    verify_status="failed(${verify_code})"
  fi
fi

echo "Created upload request"
echo "Request ID: ${request_id}"
echo "Public URL: ${upload_link}"
echo "Target Path: ${target_path}"
if [[ -n "$expires_at" ]]; then
  if expire_human="$(date -d "@${expires_at}" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null)"; then
    echo "Expires At: ${expire_human} (${expires_at})"
  else
    echo "Expires At (epoch): ${expires_at}"
  fi
else
  echo "Expires At: never"
fi
echo "Verification: ${verify_status}"
