#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 4 ]]; then
  echo "usage: $(basename "$0") <share-hash> [base-url] [concurrency] [count]" >&2
  echo "example: $(basename "$0") 4OzFiCVh http://localhost:8098 4 25" >&2
  exit 2
fi

share_hash="$1"
base_url="${2:-http://localhost:8098}"
concurrency="${3:-4}"
count="${4:-25}"
base_url="${base_url%/}"

files_json="$(curl -fsS "${base_url}/api/share/${share_hash}/files")"

python3 - "$files_json" "$share_hash" "$base_url" "$count" <<'PY' \
 | head -n "$count" \
 | xargs -n 1 -P "$concurrency" sh -c '
url="$1"
code="$(curl -sS -o /dev/null -w "%{http_code}" "$url" || true)"
if [ "$code" != "200" ]; then
  echo "FAIL $code $url" >&2
  exit 1
fi
echo "ok $url"
' _
import json
import sys
from urllib.parse import quote

data = json.loads(sys.argv[1])
share_hash = sys.argv[2]
base_url = sys.argv[3].rstrip("/")
count = int(sys.argv[4])

items = [x for x in data if isinstance(x, dict)]
items = [x for x in items if x.get("path") and x.get("type") in ("image", "video")]
items = items[: max(0, count)]

for item in items:
    path = str(item["path"])
    size = int(item.get("size") or 0)
    encoded = quote(path, safe="/")
    print(f"{base_url}/api/share/{share_hash}/preview/{encoded}?v={size}")
PY

echo "PASS"
