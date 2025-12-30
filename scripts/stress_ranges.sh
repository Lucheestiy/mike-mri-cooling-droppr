#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 6 ]]; then
  echo "usage: $(basename "$0") <share-hash> <file-path> [base-url] [concurrency] [count] [range-bytes]" >&2
  echo "example: $(basename "$0") 4OzFiCVh IMG_4492.mov http://localhost:8098 6 40 1048576" >&2
  exit 2
fi

share_hash="$1"
file_path="$2"
base_url="${3:-http://localhost:8098}"
concurrency="${4:-6}"
count="${5:-40}"
range_bytes="${6:-1048576}"
base_url="${base_url%/}"

python3 - <<'PY' "$share_hash"
import re, sys
share=sys.argv[1]
if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", share or ""):
    raise SystemExit("FAIL: invalid share hash")
PY

encoded_path="$(python3 - <<'PY' "$file_path"
from urllib.parse import quote
import sys
path=str(sys.argv[1] or "")
if path.startswith("/") or path.startswith("\\") or "\\" in path:
    raise SystemExit("FAIL: invalid file path")
parts=[p for p in path.split("/") if p]
if not parts or any(p==".." for p in parts):
    raise SystemExit("FAIL: invalid file path")
print(quote("/".join(parts), safe="/"))
PY
)"

url="${base_url}/api/public/dl/${share_hash}/${encoded_path}?inline=true"

echo "HEAD ${url}"
content_length="$(curl -sS -I "${url}" | tr -d '\r' | awk '{k=tolower($1); if(k=="content-length:"){print $2}}' | tail -n 1)"
if [[ -z "${content_length}" ]]; then
  echo "FAIL: missing Content-Length" >&2
  exit 1
fi
echo "ok: Content-Length ${content_length}"

echo "Generating ${count} ranges (${range_bytes} bytes each), concurrency=${concurrency}"
ranges="$(python3 - <<'PY' "$content_length" "$count" "$range_bytes"
import random, sys
size=int(sys.argv[1])
count=int(sys.argv[2])
span=int(sys.argv[3])
span=max(1, min(span, size))
max_start=max(0, size-span)
random.seed(0xD0CC)
for _ in range(max(0, count)):
    start=random.randint(0, max_start) if max_start else 0
    end=start+span-1
    print(f"{start}-{end}")
PY
)"

printf '%s\n' "$ranges" | xargs -P "$concurrency" -I {} sh -c '
range="$1"
url="$2"
code="$(curl -sS -o /dev/null -w "%{http_code}" -H "Range: bytes=${range}" "${url}" || true)"
if [ "$code" != "206" ]; then
  echo "FAIL: ${code} Range: bytes=${range} ${url}" >&2
  exit 1
fi
' _ {} "$url"

echo "PASS"
