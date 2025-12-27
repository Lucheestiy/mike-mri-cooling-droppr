#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $(basename "$0") <public-media-url>" >&2
  echo "example: $(basename "$0") 'https://droppr.coolmri.com/api/public/dl/<share>/<file>?inline=true'" >&2
  exit 2
fi

url="$1"

echo "HEAD $url"
head_code="$(curl -sS -o /dev/null -w '%{http_code}' -I "$url")"
if [[ "$head_code" == "404" ]]; then
  echo "FAIL: HEAD returned 404 (clients often rely on HEAD for media metadata)" >&2
  exit 1
fi
echo "ok: HEAD $head_code"

echo "Range $url"
range_code="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-1023' "$url")"
if [[ "$range_code" != "206" && "$range_code" != "200" ]]; then
  echo "FAIL: expected 206 (or 200), got $range_code" >&2
  exit 1
fi
echo "ok: Range $range_code"

echo "Conditional GET $url"
ims_code="$(curl -sS -o /dev/null -w '%{http_code}' -H 'If-Modified-Since: Sat, 01 Jan 2000 00:00:00 GMT' "$url")"
if [[ "$ims_code" == "304" ]]; then
  echo "FAIL: got 304; some media clients can hang on replay when cached partials are reused" >&2
  exit 1
fi
echo "ok: Conditional GET $ims_code"

echo "PASS"
