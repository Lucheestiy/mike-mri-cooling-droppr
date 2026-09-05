#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $(basename "$0") <robust-share-id> [base-url]" >&2
  echo "example: $(basename "$0") RS_abc123 https://droppr.coolmri.com" >&2
  exit 2
fi

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "FAIL: required command is missing: ${cmd}" >&2
    exit 127
  fi
}

for cmd in awk curl grep mktemp python3 sed tar wc; do
  require_cmd "${cmd}"
done

share_id="$1"
base_url="${2:-https://droppr.coolmri.com}"
base_url="${base_url%/}"
tmp_files=()

cleanup() {
  if [[ "${#tmp_files[@]}" -gt 0 ]]; then
    rm -f "${tmp_files[@]}"
  fi
}
trap cleanup EXIT

python3 - <<'PY' "$share_id"
import re
import sys

sid = sys.argv[1]
if not re.fullmatch(r"RS_[A-Za-z0-9_-]{1,64}", sid or ""):
    raise SystemExit("FAIL: invalid robust share id (expected RS_...)")
print("ok: robust share id format")
PY

page_url="${base_url}/share/${share_id}"
echo "GET ${page_url}"
html="$(curl -fsS "${page_url}")"
if ! grep -Fq "Shared Files" <<<"${html}"; then
  echo "FAIL: robust share HTML missing expected text" >&2
  exit 1
fi
echo "ok: share HTML"
for marker in 'id="search-input"' 'id="filtered-files-count"' 'id="select-all-label"'; do
  if ! grep -Fq "${marker}" <<<"${html}"; then
    echo "FAIL: robust share HTML missing search UI marker: ${marker}" >&2
    exit 1
  fi
done
echo "ok: share search UI"
for marker in 'id="copy-link-btn"' 'id="protection-state"' 'id="expiry-state"' 'id="password-share-meta"'; do
  if ! grep -Fq "${marker}" <<<"${html}"; then
    echo "FAIL: robust share HTML missing recipient status marker: ${marker}" >&2
    exit 1
  fi
done
echo "ok: share recipient status UI"

info_url="${base_url}/api/robust-share/${share_id}/info"
echo "GET ${info_url}"
info_json="$(curl -fsS "${info_url}")"

python3 - <<'PY' "$info_json"
import json
import sys

data = json.loads(sys.argv[1])
required = {"share_id", "title", "share_type", "password_protected", "total_size", "file_count"}
if not isinstance(data, dict):
    raise SystemExit("FAIL: info is not an object")
missing = sorted(required - set(data.keys()))
if missing:
    raise SystemExit(f"FAIL: info missing keys: {', '.join(missing)}")
print("ok: info JSON")
PY

files_url="${base_url}/api/robust-share/${share_id}/files"
echo "GET ${files_url}"
files_json="$(curl -fsS "${files_url}")"

selection_json="$(
python3 - <<'PY' "$files_json"
import json
import sys

data = json.loads(sys.argv[1])
all_files = data.get("all_files") or []
all_files = [f for f in all_files if isinstance(f, dict) and isinstance(f.get("path"), str)]
all_files.sort(key=lambda f: int(f.get("size") or 0))
selected = [f["path"] for f in all_files[:3]]
print(json.dumps(selected))
PY
)"

if [[ "${selection_json}" == "[]" ]]; then
  echo "FAIL: share contains no files to sample" >&2
  exit 1
fi
selected_count="$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "$selection_json")"
echo "ok: selected sample ${selected_count} file(s)"

python3 - <<'PY' "$selection_json"
import json
import sys

selected = json.loads(sys.argv[1])
if any("\n" in p or "\r" in p for p in selected):
    raise SystemExit("FAIL: selected paths contain newline characters; smoke script refuses ambiguous path accounting")
PY

# For each selected file, HEAD the public download endpoint to get authoritative sizes.
sizes=()
paths=()
while IFS= read -r path; do
  encoded="$(
  python3 - <<'PY' "$path"
from urllib.parse import quote
import sys
print(quote(str(sys.argv[1] or ""), safe="/"))
PY
  )"

  file_url="${base_url}/api/robust-share/${share_id}/download/${encoded}"
  echo "HEAD ${file_url}"
  content_length="$(
    curl -fsS -I "${file_url}" \
      | tr -d '\r' \
      | awk '{k=tolower($1); if(k=="content-length:"){print $2}}' \
      | tail -n 1
  )"
  if [[ -z "${content_length}" ]]; then
    echo "FAIL: missing Content-Length for ${path}" >&2
    exit 1
  fi
  if ! [[ "${content_length}" =~ ^[0-9]+$ ]]; then
    echo "FAIL: invalid Content-Length (${content_length}) for ${path}" >&2
    exit 1
  fi
  sizes+=("${content_length}")
  paths+=("${path}")

  echo "ok: ${content_length} bytes"
done < <(python3 -c 'import json,sys; [print(x) for x in json.loads(sys.argv[1])]' "$selection_json")

# Compute expected tar Content-Length:
# total = 1024 end markers + sum(512 header + size + 512-padding)
expected=1024
for s in "${sizes[@]}"; do
  padding=$(( (512 - (s % 512)) % 512 ))
  expected=$(( expected + 512 + s + padding ))
done

files_q="$(
python3 - <<'PY' "$selection_json"
from urllib.parse import quote
import sys
print(quote(sys.argv[1], safe=""))
PY
)"

selected_url="${base_url}/api/robust-share/${share_id}/download-selected?files=${files_q}"
echo "HEAD ${selected_url}"
selected_len="$(
  curl -fsS -I "${selected_url}" \
    | tr -d '\r' \
    | awk '{k=tolower($1); if(k=="content-length:"){print $2}}' \
    | tail -n 1
)"
if [[ -z "${selected_len}" ]]; then
  echo "FAIL: download-selected missing Content-Length" >&2
  exit 1
fi
if [[ "${selected_len}" != "${expected}" ]]; then
  echo "FAIL: download-selected Content-Length mismatch (got=${selected_len} expected=${expected})" >&2
  exit 1
fi
echo "ok: download-selected Content-Length ${selected_len}"

# Optional: fully list tar members if small enough.
max_bytes="${DROPPR_SMOKE_MAX_SELECTED_BYTES:-52428800}" # 50 MiB default
if ! [[ "${max_bytes}" =~ ^[0-9]+$ ]] || [[ "${max_bytes}" -lt 1 ]]; then
  echo "FAIL: DROPPR_SMOKE_MAX_SELECTED_BYTES must be a positive integer, got: ${max_bytes}" >&2
  exit 2
fi
if (( expected <= max_bytes )); then
  echo "GET ${selected_url} (listing tar members)"
  tar_list="$(curl -fsS "${selected_url}" | tar -tf -)"
  lines="$(wc -l <<<"${tar_list}" | tr -d ' ')"
  if [[ "${lines}" != "${selected_count}" ]]; then
    echo "FAIL: expected ${selected_count} tar members, got ${lines}" >&2
    echo "${tar_list}" >&2
    exit 1
  fi
  if grep -Fq "/" <<<"${tar_list}"; then
    echo "FAIL: download-selected tar should be flat (no '/'), got:" >&2
    echo "${tar_list}" >&2
    exit 1
  fi
  echo "ok: tar members (flat):"
  printf '%s\n' "${tar_list}"
else
  echo "skip: tar listing (expected ${expected} bytes > ${max_bytes} threshold)"
fi

# ZIP mode (more familiar on Windows/iOS).
zip_url="${base_url}/api/robust-share/${share_id}/download-selected?format=zip&files=${files_q}"
echo "HEAD ${zip_url}"
zip_headers="$(curl -fsS -I "${zip_url}" | tr -d '\r')"
zip_type="$(grep -Ei '^content-type:' <<<"${zip_headers}" | tail -n 1 | sed -E 's/^content-type: *//I' || true)"
if [[ "${zip_type}" != application/zip* ]]; then
  echo "FAIL: expected Content-Type application/zip, got: ${zip_type:-<missing>}" >&2
  exit 1
fi
zip_disp="$(grep -Ei '^content-disposition:' <<<"${zip_headers}" | tail -n 1 || true)"
if ! grep -Eq '\.zip' <<<"${zip_disp}"; then
  echo "FAIL: expected Content-Disposition filename to include .zip, got: ${zip_disp:-<missing>}" >&2
  exit 1
fi
zip_len="$(grep -Ei '^content-length:' <<<"${zip_headers}" | tail -n 1 | awk '{print $2}' || true)"
if [[ -z "${zip_len}" || ! "${zip_len}" =~ ^[0-9]+$ || "${zip_len}" == "0" ]]; then
  echo "FAIL: zip download-selected missing/invalid Content-Length (${zip_len:-<missing>})" >&2
  exit 1
fi
echo "ok: download-selected ZIP headers (${zip_len} bytes)"

if (( zip_len <= max_bytes )); then
  tmp="$(mktemp)"
  tmp_files+=("${tmp}")
  echo "GET ${zip_url} (listing zip members)"
  curl -fsS -o "${tmp}" "${zip_url}"
  python3 - <<'PY' "${tmp}" "${selection_json}"
import json
import sys
import zipfile

path = sys.argv[1]
selected = json.loads(sys.argv[2])

with zipfile.ZipFile(path, "r") as zf:
    names = zf.namelist()

if len(names) != len(selected):
    raise SystemExit(f"FAIL: expected {len(selected)} zip members, got {len(names)}: {names}")
if any("/" in n.strip("/") for n in names):
    raise SystemExit(f"FAIL: expected flat zip member names, got: {names}")
print("ok: zip members (flat):")
for n in names:
    print(n)
PY
else
  echo "skip: zip listing (zip ${zip_len} bytes > ${max_bytes} threshold)"
fi

# download-all should have a Content-Length (can be huge; HEAD only).
all_url="${base_url}/api/robust-share/${share_id}/download-all"
echo "HEAD ${all_url}"
all_len="$(
  curl -fsS -I "${all_url}" \
    | tr -d '\r' \
    | awk '{k=tolower($1); if(k=="content-length:"){print $2}}' \
    | tail -n 1
)"
if [[ -z "${all_len}" || ! "${all_len}" =~ ^[0-9]+$ || "${all_len}" == "0" ]]; then
  echo "FAIL: download-all missing/invalid Content-Length (${all_len:-<missing>})" >&2
  exit 1
fi
echo "ok: download-all Content-Length ${all_len}"

# ZIP mode for download-all (HEAD only).
zip_all_url="${base_url}/api/robust-share/${share_id}/download-all?format=zip"
echo "HEAD ${zip_all_url}"
zip_all_headers="$(curl -fsS -I "${zip_all_url}" | tr -d '\r')"
zip_all_type="$(grep -Ei '^content-type:' <<<"${zip_all_headers}" | tail -n 1 | sed -E 's/^content-type: *//I' || true)"
if [[ "${zip_all_type}" != application/zip* ]]; then
  echo "FAIL: expected download-all ZIP Content-Type application/zip, got: ${zip_all_type:-<missing>}" >&2
  exit 1
fi
zip_all_len="$(grep -Ei '^content-length:' <<<"${zip_all_headers}" | tail -n 1 | awk '{print $2}' || true)"
if [[ -z "${zip_all_len}" || ! "${zip_all_len}" =~ ^[0-9]+$ || "${zip_all_len}" == "0" ]]; then
  echo "FAIL: download-all ZIP missing/invalid Content-Length (${zip_all_len:-<missing>})" >&2
  exit 1
fi
echo "ok: download-all ZIP Content-Length ${zip_all_len}"

# Range support on a sample file (resume/stream).
sample_path="${paths[0]}"
sample_encoded="$(python3 - <<'PY' "$sample_path"
from urllib.parse import quote
import sys
print(quote(str(sys.argv[1] or ""), safe="/"))
PY
)"
sample_url="${base_url}/api/robust-share/${share_id}/download/${sample_encoded}"
echo "Range ${sample_url}"
range_code="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-0' "${sample_url}" || true)"
if [[ "${range_code}" != "206" ]]; then
  echo "FAIL: expected 206 for Range request, got ${range_code}" >&2
  exit 1
fi
echo "ok: Range 206"

# Negative cases.
echo "GET ${base_url}/api/robust-share/INVALID/info (expect 400)"
bad_code="$(curl -sS -o /dev/null -w '%{http_code}' "${base_url}/api/robust-share/INVALID/info" || true)"
if [[ "${bad_code}" != "400" ]]; then
  echo "FAIL: expected 400 for invalid robust share id, got ${bad_code}" >&2
  exit 1
fi
echo "ok: invalid robust id rejected (400)"

echo "GET traversal download (expect 400)"
trav_code="$(curl -sS -o /dev/null -w '%{http_code}' "${base_url}/api/robust-share/${share_id}/download/%2e%2e%2fetc%2fpasswd" || true)"
if [[ "${trav_code}" != "400" ]]; then
  echo "FAIL: expected 400 for traversal path, got ${trav_code}" >&2
  exit 1
fi
echo "ok: traversal rejected (400)"

echo "POST refresh without auth (expect 401)"
refresh_code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${base_url}/api/robust-share/${share_id}/refresh" || true)"
if [[ "${refresh_code}" != "401" ]]; then
  echo "FAIL: unauthenticated refresh returned ${refresh_code}, expected 401" >&2
  exit 1
fi
echo "ok: unauthenticated refresh rejected (401)"

echo "PASS"
