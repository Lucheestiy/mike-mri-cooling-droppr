#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

timestamp="$(date -u +"%Y%m%d-%H%M%S")"
out_dir="${DROPPR_BACKUP_DIR:-${repo_root}/backups}"
out_file="${out_dir}/droppr-backup-${timestamp}.tar.gz"

mkdir -p "${out_dir}"

tmp="$(mktemp -d)"
cleanup() { rm -rf "${tmp}"; }
trap cleanup EXIT

# Copy only small, important state by default (avoid proxy/thumbnails and uploaded media).
mkdir -p "${tmp}/database" "${tmp}/config"

shopt -s nullglob

for f in database/*.sqlite3 database/filebrowser.db; do
  if [[ -f "${f}" ]]; then
    cp -a "${f}" "${tmp}/database/"
  fi
done

if [[ -f "config/settings.json" ]]; then
  cp -a "config/settings.json" "${tmp}/config/"
fi

if [[ "${DROPPR_BACKUP_INCLUDE_ADMIN_PASSWORD:-false}" == "true" && -f "config/admin-password.txt" ]]; then
  cp -a "config/admin-password.txt" "${tmp}/config/"
fi

cp -a "docker-compose.yml" "${tmp}/" 2>/dev/null || true

tar -czf "${out_file}" -C "${tmp}" .

echo "OK: wrote ${out_file}"
echo "Includes:"
echo "- database/*.sqlite3"
echo "- database/filebrowser.db (if present)"
echo "- config/settings.json (if present)"
if [[ "${DROPPR_BACKUP_INCLUDE_ADMIN_PASSWORD:-false}" == "true" ]]; then
  echo "- config/admin-password.txt (enabled)"
else
  echo "- config/admin-password.txt (not included; set DROPPR_BACKUP_INCLUDE_ADMIN_PASSWORD=true)"
fi

