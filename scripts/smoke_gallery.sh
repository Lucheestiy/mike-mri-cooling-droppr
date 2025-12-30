#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $(basename "$0") <share-hash> [base-url]" >&2
  echo "example: $(basename "$0") 4OzFiCVh https://droppr.coolmri.com" >&2
  exit 2
fi

share_hash="$1"
base_url="${2:-https://droppr.coolmri.com}"
base_url="${base_url%/}"

gallery_url="${base_url}/gallery/${share_hash}"
files_url="${base_url}/api/share/${share_hash}/files"

echo "GET ${gallery_url}"
html="$(curl -fsS "${gallery_url}")"
if ! printf '%s' "${html}" | rg -q "Shared Media Gallery"; then
  echo "FAIL: gallery HTML missing expected title text" >&2
  exit 1
fi
version="$(printf '%s' "${html}" | head -n 1 | tr -d '\r' | sed -E 's/^<!-- *VERSION: *([^ ]+).*/\1/' || true)"
echo "ok: gallery HTML (version=${version:-unknown})"

echo "GET ${files_url}"
json="$(curl -fsS "${files_url}")"

python3 - <<'PY' "$json"
import json
import sys

data = json.loads(sys.argv[1])
if not isinstance(data, list):
    raise SystemExit("FAIL: expected JSON array")
if not data:
    print("ok: files list (0 items)")
    raise SystemExit(0)

required = {"name", "path", "type", "extension", "size", "inline_url", "download_url"}
missing = []
for idx, item in enumerate(data[:10]):
    if not isinstance(item, dict):
        raise SystemExit(f"FAIL: item {idx} is not an object")
    miss = sorted(required - set(item.keys()))
    if miss:
        missing.append((idx, miss))
if missing:
    idx, miss = missing[0]
    raise SystemExit(f"FAIL: item {idx} missing keys: {', '.join(miss)}")

images = [f for f in data if f.get("type") == "image"]
videos = [f for f in data if f.get("type") == "video"]
print(f"ok: files list ({len(data)} items; images={len(images)} videos={len(videos)})")

def pick(items):
    return items[0] if items else None

picked = {
    "image": pick(images),
    "video": pick(videos),
    "any": data[0],
}

print(json.dumps(picked))
PY

picked="$(python3 - <<'PY' "$json"
import json, sys
data=json.loads(sys.argv[1])
images=[f for f in data if isinstance(f, dict) and f.get("type")=="image"]
videos=[f for f in data if isinstance(f, dict) and f.get("type")=="video"]
def pick(items): return items[0] if items else None
print(json.dumps({"image": pick(images), "video": pick(videos), "any": data[0] if data else None}))
PY
)"

thumb_path_encoded="$(python3 - <<'PY' "$picked"
import json, sys
from urllib.parse import quote
p=json.loads(sys.argv[1])
item=p.get("any") or {}
path=item.get("path") or item.get("name") or ""
print(quote(path, safe="/"))
PY
)"

if [[ -n "$thumb_path_encoded" ]]; then
  preview_url="${base_url}/api/share/${share_hash}/preview/${thumb_path_encoded}"
  echo "GET ${preview_url}"
  content_type="$(curl -fsS -D- -o /dev/null "${preview_url}" | tr -d '\r' | rg -i '^content-type:' | head -n 1 | sed -E 's/^content-type: *//I' || true)"
  if [[ "$content_type" != image/jpeg* ]]; then
    echo "FAIL: expected Content-Type image/jpeg, got: ${content_type:-<missing>}" >&2
    exit 1
  fi
  echo "ok: preview Content-Type ${content_type}"
fi

inline_url="$(python3 - <<'PY' "$picked"
import json, sys
p=json.loads(sys.argv[1])
item=p.get("video") or p.get("image") or {}
print(item.get("inline_url",""))
PY
)"

if [[ -n "$inline_url" ]]; then
  echo "smoke_media ${base_url}${inline_url}"
  "$(dirname "$0")/smoke_media.sh" "${base_url}${inline_url}"
fi

video_path_encoded="$(python3 - <<'PY' "$picked"
import json, sys
from urllib.parse import quote
p=json.loads(sys.argv[1])
item=p.get("video") or {}
path=item.get("path") or item.get("name") or ""
print(quote(str(path), safe="/"))
PY
)"

if [[ -n "$video_path_encoded" ]]; then
  player_url="${base_url}/player?share=${share_hash}&file=${video_path_encoded}"
  echo "GET ${player_url}"
  player_html="$(curl -fsS "${player_url}")"
  if ! printf '%s' "${player_html}" | rg -q 'id="video"'; then
    echo "FAIL: player HTML missing video element" >&2
    exit 1
  fi
  echo "ok: player HTML"
fi

download_url="$(python3 - <<'PY' "$picked"
import json, sys
p=json.loads(sys.argv[1])
item=p.get("any") or {}
print(item.get("download_url",""))
PY
)"

if [[ -n "$download_url" ]]; then
  url="${base_url}${download_url}"
  echo "HEAD ${url}"
  code="$(curl -sS -o /dev/null -w '%{http_code}' -I "${url}")"
  if [[ "$code" != "302" && "$code" != "301" && "$code" != "200" ]]; then
    echo "FAIL: expected 301/302/200, got ${code}" >&2
    exit 1
  fi
  echo "ok: download endpoint ${code}"
fi

# Negative cases (should not fall through to FileBrowser auth)
echo "GET ${base_url}/api/share/INVALID!/files (expect 400)"
bad_code="$(curl -sS -o /dev/null -w '%{http_code}' "${base_url}/api/share/INVALID!/files" || true)"
if [[ "$bad_code" != "400" ]]; then
  echo "FAIL: expected 400 for invalid hash, got ${bad_code}" >&2
  exit 1
fi
echo "ok: invalid hash rejected (400)"

echo "GET ${base_url}/api/share/${share_hash}/preview/%2e%2e%2fetc%2fpasswd (expect 400)"
trav_code="$(curl -sS -o /dev/null -w '%{http_code}' "${base_url}/api/share/${share_hash}/preview/%2e%2e%2fetc%2fpasswd" || true)"
if [[ "$trav_code" != "400" ]]; then
  echo "FAIL: expected 400 for traversal path, got ${trav_code}" >&2
  exit 1
fi
echo "ok: traversal rejected (400)"

echo "PASS"
