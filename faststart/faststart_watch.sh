#!/usr/bin/env sh
set -eu

WATCH_DIR="${WATCH_DIR:-/srv}"

echo "droppr-faststart: watching ${WATCH_DIR} for new .mov/.mp4/.m4v uploads"

inotifywait -m -r -e close_write -e moved_to --format '%w%f' "${WATCH_DIR}" | while IFS= read -r path; do
  lower="$(printf '%s' "${path}" | tr '[:upper:]' '[:lower:]')"

  case "${lower}" in
    *.mov|*.mp4|*.m4v) ;;
    *) continue ;;
  esac

  case "${lower}" in
    */.*) continue ;;
    *.original.*) continue ;;
    *.faststart.*) continue ;;
    *.tmp) continue ;;
  esac

  python3 /app/faststart.py "${path}" || true
done
