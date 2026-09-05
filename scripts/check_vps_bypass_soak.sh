#!/usr/bin/env bash
set -euo pipefail

domain="droppr.coolmri.com"
vps_ip="104.236.97.60"
unit="droppr-direct-smoke.service"
timer="droppr-direct-smoke.timer"
hours=24
min_successes=""
timer_interval_minutes=""
timer_interval_explicit=0
range_url="https://droppr.coolmri.com/api/robust-share/RS_droppr_direct_smoke/download/range-sentinel.txt"
resolvers=(1.1.1.1 8.8.8.8 9.9.9.9)
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: check_vps_bypass_soak.sh [--hours N] [--min-successes N] [--expected-interval-minutes N] [--domain HOST] [--vps-ip IP]

Returns 0 only when the direct VPS bypass looks ready to run without the
cloudflared rollback container. Default policy is a 24-hour soak window
with at least two thirds of expected timer runs succeeding.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours)
      hours="${2:?missing value for --hours}"
      shift 2
      ;;
    --min-successes)
      min_successes="${2:?missing value for --min-successes}"
      shift 2
      ;;
    --expected-interval-minutes)
      timer_interval_minutes="${2:?missing value for --expected-interval-minutes}"
      timer_interval_explicit=1
      shift 2
      ;;
    --domain)
      domain="${2:?missing value for --domain}"
      shift 2
      ;;
    --vps-ip)
      vps_ip="${2:?missing value for --vps-ip}"
      shift 2
      ;;
    --range-url)
      range_url="${2:?missing value for --range-url}"
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

duration_to_minutes() {
  local value="$1"

  if [[ "${value}" =~ ^([0-9]+)(s|sec|secs|second|seconds)$ ]]; then
    echo $(((BASH_REMATCH[1] + 59) / 60))
    return 0
  fi
  if [[ "${value}" =~ ^([0-9]+)(m|min|mins|minute|minutes)$ ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "${value}" =~ ^([0-9]+)(h|hr|hour|hours)$ ]]; then
    echo $((BASH_REMATCH[1] * 60))
    return 0
  fi
  if [[ "${value}" =~ ^[0-9]+$ ]]; then
    echo $(((value + 59) / 60))
    return 0
  fi

  return 1
}

derive_timer_interval_minutes() {
  local timer_body interval
  timer_body="$(
    systemctl cat "${timer}" 2>/dev/null || true
    if [[ -f "${script_dir}/../deploy/${timer}" ]]; then
      cat "${script_dir}/../deploy/${timer}"
    fi
  )"
  interval="$(printf '%s\n' "${timer_body}" | awk -F= '/^OnUnitActiveSec=/{print $2; exit}')"
  if [[ -z "${interval}" ]]; then
    return 1
  fi
  duration_to_minutes "${interval}"
}

if ! [[ "${hours}" =~ ^[0-9]+$ ]] || [[ "${hours}" -lt 1 ]]; then
  echo "FAIL: --hours must be a positive integer" >&2
  exit 2
fi

if [[ -n "${timer_interval_minutes}" ]]; then
  if ! [[ "${timer_interval_minutes}" =~ ^[0-9]+$ ]] || [[ "${timer_interval_minutes}" -lt 1 ]]; then
    echo "FAIL: --expected-interval-minutes must be a positive integer" >&2
    exit 2
  fi
fi

derived_timer_interval_minutes="$(derive_timer_interval_minutes || true)"
if [[ "${timer_interval_explicit}" -eq 1 && -n "${derived_timer_interval_minutes}" && "${derived_timer_interval_minutes}" -ne "${timer_interval_minutes}" ]]; then
  echo "FAIL: --expected-interval-minutes (${timer_interval_minutes}) does not match ${timer} OnUnitActiveSec (${derived_timer_interval_minutes})" >&2
  exit 2
fi
if [[ -z "${timer_interval_minutes}" ]]; then
  timer_interval_minutes="${derived_timer_interval_minutes}"
fi

if [[ -z "${min_successes}" ]]; then
  if [[ -z "${timer_interval_minutes}" ]]; then
    echo "FAIL: could not derive timer interval; pass --min-successes or --expected-interval-minutes" >&2
    exit 2
  fi
  expected_runs=$(((hours * 60 + timer_interval_minutes - 1) / timer_interval_minutes))
  min_successes=$(((expected_runs * 2 + 2) / 3))
fi

if ! [[ "${min_successes}" =~ ^[0-9]+$ ]] || [[ "${min_successes}" -lt 1 ]]; then
  echo "FAIL: --min-successes must be a positive integer" >&2
  exit 2
fi

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "FAIL: required command is missing: ${cmd}" >&2
    exit 127
  fi
}

for cmd in awk curl dig grep journalctl sed systemctl tr; do
  require_cmd "${cmd}"
done

failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

ok() {
  echo "ok: $*"
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

echo "== Timer =="
if systemctl is-active --quiet "${timer}"; then
  ok "${timer} is active"
else
  fail "${timer} is not active"
fi

echo
echo "== Smoke History (${hours}h) =="
if [[ -n "${timer_interval_minutes}" ]]; then
  echo "timer interval: ${timer_interval_minutes} minute(s)"
fi
logs="$(journalctl -u "${unit}" --since "${hours} hours ago" --no-pager -o cat || true)"
unit_logs="$(journalctl -u "${unit}" --since "${hours} hours ago" --no-pager || true)"
success_count="$(printf '%s\n' "${logs}" | grep -Ec '(^PASS: DROPPR_DIRECT_VPS_HEALTHY\b|^PASS: direct VPS path is healthy$)' || true)"
failure_count="$(
  {
    printf '%s\n' "${logs}" | grep -Ei 'FAIL:' || true
    printf '%s\n' "${unit_logs}" | grep -Ei 'status=[1-9][0-9]*/FAILURE|code=exited, status=[1-9][0-9]*' || true
  } | grep -c . || true
)"
echo "successes: ${success_count}"
echo "failures: ${failure_count}"

if [[ "${success_count}" -ge "${min_successes}" ]]; then
  ok "success count meets threshold ${min_successes}"
else
  fail "success count ${success_count} is below threshold ${min_successes}"
fi

if [[ "${failure_count}" -eq 0 ]]; then
  ok "no failures in ${unit} journal window"
else
  fail "${failure_count} possible failure(s) in ${unit} journal window"
fi

echo
echo "== DNS =="
for resolver in "${resolvers[@]}"; do
  answer="$(dig +short "${domain}" A @"${resolver}" | sed '/^$/d')"
  echo "${resolver}: $(printf '%s\n' "${answer}" | tr '\n' ' ')"
  if printf '%s\n' "${answer}" | grep -Fxq "${vps_ip}"; then
    ok "A ${domain} via ${resolver} includes ${vps_ip}"
  else
    fail "A ${domain} via ${resolver} did not include ${vps_ip}"
  fi
done

echo
echo "== Public HTTPS =="
headers="$(curl -sS -I --connect-timeout 8 --max-time 20 "https://${domain}/" || true)"
printf '%s\n' "${headers}" | sed -n '1,14p'
code="$(printf '%s\n' "${headers}" | tr -d '\r' | http_status)"
if [[ "${code}" == "200" ]]; then
  ok "public HTTPS returned 200"
else
  fail "public HTTPS returned ${code:-<none>}"
fi

if has_cloudflare_authoritative_headers "${headers}"; then
  fail "public HTTPS still shows Cloudflare headers"
else
  ok "public HTTPS has no Cloudflare headers"
fi
if has_cloudflare_policy_headers "${headers}"; then
  echo "warn: public HTTPS still includes Cloudflare reporting policy headers"
fi

echo
echo "== Range Sentinel =="
range_headers="$(curl -sS -r 0-1023 -D - -o /dev/null --connect-timeout 8 --max-time 60 "${range_url}" || true)"
printf '%s\n' "${range_headers}" | sed -n '1,14p'
range_code="$(printf '%s\n' "${range_headers}" | tr -d '\r' | http_status)"
if [[ "${range_code}" == "206" ]]; then
  ok "range sentinel returned 206"
else
  fail "range sentinel returned ${range_code:-<none>}"
fi

if headers_have "${range_headers}" '^content-range: bytes '; then
  ok "range sentinel includes Content-Range"
else
  fail "range sentinel did not include Content-Range"
fi

echo
if [[ "${failures}" -eq 0 ]]; then
  echo "READY: direct VPS bypass soak checks passed"
  exit 0
fi

echo "NOT READY: ${failures} check(s) failed"
exit 1
