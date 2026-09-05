#!/usr/bin/env bash
set -euo pipefail

base_url="https://droppr.coolmri.com"
robust_share_id="RS_droppr_direct_smoke"
gallery_hash=""
run_vps=1
run_admin=1

usage() {
  cat <<'EOF'
Usage: smoke_stack.sh [--base-url URL] [--robust-share RS_ID] [--gallery HASH] [--skip-vps] [--skip-admin]

Runs the highest-signal Droppr smoke checks:
  - direct VPS bypass checks for the base URL hostname
  - Robust Share public browsing/download/archive/range checks
  - local admin upload-request audit checks when Docker Compose is available
  - optional FileBrowser gallery checks when --gallery is provided

Use --skip-vps for localhost/dev URLs that are not expected to resolve to the
production VPS.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      base_url="${2:?missing value for --base-url}"
      shift 2
      ;;
    --robust-share)
      robust_share_id="${2:?missing value for --robust-share}"
      shift 2
      ;;
    --gallery)
      gallery_hash="${2:?missing value for --gallery}"
      shift 2
      ;;
    --skip-vps)
      run_vps=0
      shift
      ;;
    --skip-admin)
      run_admin=0
      shift
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

base_url="${base_url%/}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
range_url="${base_url}/api/robust-share/${robust_share_id}/download/range-sentinel.txt"
vps_domain=""
if [[ "${run_vps}" -eq 1 ]]; then
  vps_domain="$(
    python3 - <<'PY' "${base_url}"
from urllib.parse import urlparse
import sys

parsed = urlparse(sys.argv[1])
if parsed.scheme != "https" or not parsed.hostname:
    raise SystemExit("FAIL: --base-url must be an https URL with a hostname, or pass --skip-vps")
print(parsed.hostname)
PY
  )"
fi

echo "== Droppr Stack Smoke =="
echo "base_url: ${base_url}"
echo "robust_share: ${robust_share_id}"
if [[ -n "${gallery_hash}" ]]; then
  echo "gallery: ${gallery_hash}"
fi
echo

if [[ "${run_vps}" -eq 1 ]]; then
  echo "== Direct VPS Bypass =="
  "${script_dir}/smoke_vps_bypass.sh" --domain "${vps_domain}" --quiet --range-url "${range_url}"
  echo
fi

echo "== Robust Share =="
"${script_dir}/smoke_robust_share.sh" "${robust_share_id}" "${base_url}"
echo

echo "== Upload Request Page =="
upload_html="$(curl -fsSL --max-time 20 "${base_url}/upload/UR_static_smoke")"
if ! grep -q 'id="fileInput"' <<<"${upload_html}"; then
  echo "FAIL: upload request page missing file input" >&2
  exit 1
fi
if ! grep -q 'id="selectionNotice"' <<<"${upload_html}"; then
  echo "FAIL: upload request page missing selection warning UI" >&2
  exit 1
fi
if ! grep -q 'data-remove-file' <<<"${upload_html}"; then
  echo "FAIL: upload request page missing per-file remove UI" >&2
  exit 1
fi
if ! grep -q 'X-Chunk-SHA256' <<<"${upload_html}"; then
  echo "FAIL: upload request page missing verified chunk uploads" >&2
  exit 1
fi
if ! grep -q 'Waiting for connection' <<<"${upload_html}"; then
  echo "FAIL: upload request page missing offline pause recovery" >&2
  exit 1
fi
if ! grep -q 'requestUploadWakeLock' <<<"${upload_html}"; then
  echo "FAIL: upload request page missing transfer wake lock" >&2
  exit 1
fi
echo "PASS: upload request page served recipient controls"
echo

if [[ "${run_admin}" -eq 1 ]]; then
  echo "== Admin Storage =="
  "${script_dir}/smoke_admin_storage.sh"
  echo

  echo "== Robust Share Admin =="
  "${script_dir}/smoke_robust_share_admin.sh" --share-id "${robust_share_id}"
  echo

  echo "== Upload Request Audit =="
  "${script_dir}/smoke_upload_request_audit.sh"
  echo
fi

if [[ -n "${gallery_hash}" ]]; then
  echo "== Gallery =="
  "${script_dir}/smoke_gallery.sh" "${gallery_hash}" "${base_url}"
  echo
else
  echo "skip: gallery smoke requires --gallery <FileBrowser share hash>"
  echo
fi

echo "PASS: Droppr stack smoke passed"
