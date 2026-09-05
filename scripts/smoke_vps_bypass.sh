#!/usr/bin/env bash
set -euo pipefail

domain="droppr.coolmri.com"
vps_ip="104.236.97.60"
test_host="droppr.104.236.97.60.nip.io"
range_url="${DROPPR_RANGE_URL:-}"
quiet=0
allow_cloudflare_cache=0
declare -a positional=()

usage() {
  cat <<'EOF'
Usage: smoke_vps_bypass.sh [--domain HOST] [--vps-ip IP] [--test-host HOST] [--range-url URL] [--allow-cloudflare-cache] [--quiet]

Legacy positional form is still supported:
  smoke_vps_bypass.sh [domain] [vps_ip] [test_host]

Set DROPPR_RANGE_URL or pass --range-url to validate a known public file/share endpoint
with Range: bytes=0-1023. The range check is skipped when no URL is provided.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      domain="${2:?missing value for --domain}"
      shift 2
      ;;
    --vps-ip)
      vps_ip="${2:?missing value for --vps-ip}"
      shift 2
      ;;
    --test-host)
      test_host="${2:?missing value for --test-host}"
      shift 2
      ;;
    --range-url)
      range_url="${2:?missing value for --range-url}"
      shift 2
      ;;
    --quiet)
      quiet=1
      shift
      ;;
    --allow-cloudflare-cache)
      allow_cloudflare_cache=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        positional+=("$1")
        shift
      done
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      positional+=("$1")
      shift
      ;;
  esac
done

domain="${positional[0]:-${domain}}"
vps_ip="${positional[1]:-${vps_ip}}"
test_host="${positional[2]:-${test_host}}"

failures=0

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "FAIL: required command is missing: ${cmd}" >&2
    exit 127
  fi
}

for cmd in awk curl dig grep sed tr; do
  require_cmd "${cmd}"
done

log() {
  if [[ "${quiet}" -eq 0 ]]; then
    printf '%s\n' "$*"
  fi
}

check_contains() {
  local label="$1"
  local value="$2"
  local expected="$3"
  if [[ "$value" == *"$expected"* ]]; then
    log "ok: ${label}"
  else
    echo "WARN: ${label} did not contain ${expected}" >&2
    failures=$((failures + 1))
  fi
}

http_status() {
  awk '/^HTTP\// { code=$2 } END { print code }'
}

headers_have() {
  local headers="$1"
  local pattern="$2"
  printf '%s\n' "${headers}" | tr -d '\r' | grep -Eiq "${pattern}"
}

has_cloudflare_authoritative_headers() {
  local headers="$1"
  headers_have "${headers}" '^(server: cloudflare|cf-ray:|cf-cache-status:)'
}

has_cloudflare_policy_headers() {
  local headers="$1"
  headers_have "${headers}" '^(report-to:.*cloudflare|nel:.*cloudflare)'
}

check_status() {
  local label="$1"
  local headers="$2"
  local expected="$3"
  local code
  code="$(printf '%s\n' "${headers}" | tr -d '\r' | http_status)"
  if [[ "${code}" == "${expected}" ]]; then
    log "ok: ${label} status ${expected}"
  else
    echo "WARN: ${label} returned HTTP ${code:-<none>}, expected ${expected}" >&2
    failures=$((failures + 1))
  fi
}

curl_headers() {
  local url="$1"
  shift
  curl -sS -I --connect-timeout 8 --max-time 20 "$@" "$url"
}

curl_body() {
  local url="$1"
  shift
  curl -sS --connect-timeout 8 --max-time 20 "$@" "$url"
}

curl_range_headers() {
  local url="$1"
  shift
  curl -sS -r 0-1023 -D - -o /dev/null --connect-timeout 8 --max-time 60 "$@" "$url"
}

section() {
  log
  log "== $1 =="
}

log "== DNS =="
for resolver in 1.1.1.1 8.8.8.8; do
  answer="$(dig +short "${domain}" A @"${resolver}" | sed '/^$/d')"
  log "${resolver}: $(printf '%s\n' "${answer}" | tr '\n' ' ')"
  if printf '%s\n' "${answer}" | grep -Fxq "${vps_ip}"; then
    log "ok: A ${domain} via ${resolver} includes ${vps_ip}"
  else
    echo "WARN: A ${domain} via ${resolver} did not include ${vps_ip}" >&2
    failures=$((failures + 1))
  fi
done

section "Forced direct HTTPS"
forced_headers="$(curl_headers "https://${domain}/" --resolve "${domain}:443:${vps_ip}")"
if [[ "${quiet}" -eq 0 ]]; then
  printf '%s\n' "${forced_headers}" | sed -n '1,16p'
fi
check_status "forced direct" "${forced_headers}" "200"
if has_cloudflare_authoritative_headers "${forced_headers}"; then
  echo "FAIL: forced direct path still reports Cloudflare" >&2
  failures=$((failures + 1))
else
  log "ok: forced direct path bypasses Cloudflare"
fi
if has_cloudflare_policy_headers "${forced_headers}"; then
  echo "WARN: forced direct response still has Cloudflare reporting policy headers" >&2
fi

section "Normal HTTPS"
normal_headers="$(curl_headers "https://${domain}/" || true)"
if [[ "${quiet}" -eq 0 ]]; then
  printf '%s\n' "${normal_headers}" | sed -n '1,16p'
fi
check_status "normal HTTPS" "${normal_headers}" "200"
if has_cloudflare_authoritative_headers "${normal_headers}"; then
  if [[ "${allow_cloudflare_cache}" -eq 1 ]]; then
    echo "WARN: normal resolver path still reaches Cloudflare; DNS cache may not have expired yet" >&2
  else
    echo "FAIL: normal resolver path still reaches Cloudflare" >&2
    failures=$((failures + 1))
  fi
else
  log "ok: normal resolver path bypasses Cloudflare"
fi
if has_cloudflare_policy_headers "${normal_headers}"; then
  echo "WARN: normal resolver response still has Cloudflare reporting policy headers" >&2
fi

section "VPS test hostname"
test_headers="$(curl_headers "https://${test_host}/")"
if [[ "${quiet}" -eq 0 ]]; then
  printf '%s\n' "${test_headers}" | sed -n '1,16p'
fi
check_status "VPS test host" "${test_headers}" "200"

section "Droppr route checks"
dotcom_headers="$(curl_headers "https://${domain}/.com" --resolve "${domain}:443:${vps_ip}")"
check_status "/.com redirect" "${dotcom_headers}" "302"
if headers_have "${dotcom_headers}" '^location: (https?://[^/]+)?/$'; then
  log "ok: /.com redirects to /"
else
  echo "WARN: /.com did not redirect to /" >&2
  failures=$((failures + 1))
fi

files_dotcom_headers="$(curl_headers "https://${domain}/files/.com" --resolve "${domain}:443:${vps_ip}")"
check_status "/files/.com redirect" "${files_dotcom_headers}" "302"
if headers_have "${files_dotcom_headers}" '^location: (https?://[^/]+)?/files$'; then
  log "ok: /files/.com redirects to /files"
else
  echo "WARN: /files/.com did not redirect to /files" >&2
  failures=$((failures + 1))
fi

config_body="$(curl_body "https://${domain}/api/droppr/client-config" --resolve "${domain}:443:${vps_ip}")"
check_contains "client config JSON" "${config_body}" '"session"'

tus_headers="$(curl_headers "https://${domain}/api/tus/" --resolve "${domain}:443:${vps_ip}")"
check_status "/api/tus/ auth gate" "${tus_headers}" "401"
if headers_have "${tus_headers}" '^content-type: .*(text/plain|application/json)'; then
  log "ok: /api/tus/ reaches FileBrowser auth instead of SPA"
else
  log "ok: /api/tus/ returned 401; content-type is not a smoke failure"
fi

if [[ -n "${range_url}" ]]; then
  section "Optional Range check"
  range_headers="$(curl_range_headers "${range_url}")"
  if [[ "${quiet}" -eq 0 ]]; then
    printf '%s\n' "${range_headers}" | sed -n '1,20p'
  fi
  check_status "Range request" "${range_headers}" "206"
  if headers_have "${range_headers}" '^content-range: bytes '; then
    log "ok: Range response includes Content-Range"
  else
    echo "WARN: Range response did not include Content-Range" >&2
    failures=$((failures + 1))
  fi
else
  section "Optional Range check"
  log "skipped: set DROPPR_RANGE_URL or pass --range-url with a public file URL"
fi

if [[ "${failures}" -gt 0 ]]; then
  log
  echo "FAIL: ${failures} required check(s) failed" >&2
  exit 1
fi

log
echo "PASS: DROPPR_DIRECT_VPS_HEALTHY direct VPS path is healthy"
