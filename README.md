# Droppr (Login-Free Share Links)

Droppr is a lightweight file sharing UI for videos/pictures using File Browser. You log in to upload/manage files and create share links; recipients can view share links without an account.

## Sharing folders (avoid ZIP downloads)

File Browser’s “download” endpoint (`/api/public/dl/<hash>`) downloads folders as a `.zip`. Droppr redirects **bare** folder-share links to the media gallery (`/gallery/<hash>`) so recipients see pictures/videos in the browser.

To download everything as a `.zip`, use the gallery’s **Download All** button (calls `/api/share/<hash>/download`).

Note: the gallery caches a share for performance. If you add new files after creating a share, reload the gallery and click **Refresh** to pull the latest folder contents.

## Analytics (downloads + IPs)

- Admin-only page: `/analytics` (requires File Browser login; uses your JWT token).
- Tracks gallery views + downloads (ZIP downloads + explicit file downloads) with timestamps and IPs.
- Stored in SQLite at `./database/droppr-analytics.sqlite3` (default retention: 180 days).
- Config via env vars on the `media-server` container:
  - `DROPPR_ANALYTICS_ENABLED=true|false`
  - `DROPPR_ANALYTICS_RETENTION_DAYS=180` (set `0` to disable retention cleanup)
  - `DROPPR_ANALYTICS_IP_MODE=full|anonymized|off`

## Admin Link Manager

- Admin page: `/manage` (lists Robust Shares + Upload Requests; revoke links; copy/open links).
- Robust Shares can be refreshed from `/manage` to rescan the original file/folder
  while keeping the same `/share/RS_*` URL.
- The same page includes a Storage & Cache panel for generated thumbnails and
  video proxy files, with admin-only cache clearing that skips recent/lock files.

## Fast Start (Better Video Streaming)

Many iPhone `.mov` uploads store the `moov` atom at the end of the file, which makes browser playback feel extremely slow (it can look like the video won’t load until most of the file downloads).

This stack includes a `droppr-faststart` service that automatically fixes new `.mov/.mp4/.m4v` uploads by moving `moov` to the front **without re-encoding**.

Some uploads require re-encoding for compatibility (notably HEVC/H.265 → H.264). Droppr is configured to prioritize visual quality (even if the file gets larger). You can tune the encoder via env vars used by the `faststart` service:

- `DROPPR_FASTSTART_X264_CRF` (default: `16`) — lower = higher quality/larger files
- `DROPPR_FASTSTART_X264_PRESET` (default: `slow`) — slower = better compression (more CPU/time)
- `DROPPR_FASTSTART_COPY_AUDIO` (default: `true`) — tries to copy audio stream; falls back to AAC if needed
- `DROPPR_FASTSTART_AAC_BITRATE` (default: `256k`) — used when audio must be re-encoded

## Video Metadata (Original vs Processed)

Some uploads are modified by `droppr-faststart` (e.g., HEVC → H.264 transcode, timestamp fixes, or faststart). Droppr records the **original** and **post-processing** metadata (size, resolution, codecs, duration) to `./database/droppr-video-meta.sqlite3` and shows it in a small “Video details” panel when previewing a video in the File Browser UI.

## Video Quality (Fast + HD)

The public gallery opens videos in `/player` and can use cached proxy MP4s (served from `/api/proxy-cache/...`) for faster reloads and seeking:

- `Auto`: on desktop, switches to `Fast` while scrolling/seeking, then upgrades to `HD` once settled; on iOS, `Auto` starts in `HD` and avoids automatic source switching.
- `Fast`: prefers the low-res proxy for quick scrubbing.
- `HD`: prefers the HD proxy (falls back while it prepares).

Proxy files are generated on-demand by `media-server` and persisted under `./database/proxy-cache/`.

## Upload Conflicts (HTTP 409)

File Browser returns HTTP `409` when uploading a file that already exists (common when a phone retries the same upload). Droppr now proxies uploads with `override=true` so retrying the same filename overwrites the existing file instead of failing.

## Auto Share Link (Single File Upload)

When you upload **exactly one file**, Droppr automatically creates a File Browser share for that file and shows the public share link immediately (it also attempts to copy it to your clipboard). Uploading multiple files keeps the normal behavior (no auto-share).

## Upload Requests (Recipients Upload Without Accounts)

Admins can generate a public **upload link** for a destination folder:

- In the File Browser **Files** view, select a destination folder and click **Upload Request**.
- Configure expiry/password/limits and share the generated `/upload/UR_...` link.
- After a successful upload, the page can generate a **view/download link** back to the uploaded folder (Robust Share).

Uploads are stored under `./data/` and request/audit metadata is stored in `./database/droppr-upload-requests.sqlite3`.

Public file requests use resumable upload sessions by default. Files are sent sequentially in bounded chunks, completed chunk indexes are persisted in SQLite, and reselecting the same file continues from the last saved chunk. Modern browsers negotiate SHA-256 verification for every chunk; a failed digest is rejected before its checkpoint is recorded and can be retried safely. During an active transfer, supported browsers hold a screen wake lock and automatically pause without consuming retries while offline, then continue the same chunk when the network returns. Individual files up to 200 GB use 32 MiB chunks (6,400 chunks at the limit). Partial sessions are retained for 30 days by default, then cleaned automatically. Abandoned sessions do not consume a request's completed-file allowance, so a transfer can restart after browser storage is lost; the server separately caps each request at 16 active sessions by default and enforces the file allowance atomically at commit. Commit recovery persists the temporary file's device and inode, preventing a same-size pre-existing target from being mistaken for a successfully moved upload after a crash.

### Upload Request CLI (robust + repeatable)

Use the API-backed helper script to create upload requests from terminal (instead of writing SQLite directly):

```bash
cd /home/mlweb/mri-cooling-droppr
./scripts/create_upload_request.sh --path /incoming --max-files 1 --expires-hours 168
```

Examples:

```bash
# No expiry, allow only media files.
./scripts/create_upload_request.sh \
  --path /incoming \
  --expires-hours 0 \
  --allowed-exts jpg,jpeg,png,heic,mp4,mov

# Use an existing X-Auth token (no password prompt).
./scripts/create_upload_request.sh \
  --path /incoming \
  --token "$DROPPR_AUTH_TOKEN"
```

## Upload Request Webhooks (Optional)

Configure `DROPPR_UPLOAD_WEBHOOK_URL` (comma-separated URLs supported) to receive JSON POST events:

- `upload_request.created`
- `upload_request.disabled`
- `upload_request.uploaded`
- `upload_request.share_created`

Optional: set `DROPPR_UPLOAD_WEBHOOK_SECRET` to receive an `X-Droppr-Signature: sha256=...` header (HMAC over the JSON body). If you set `DROPPR_PUBLIC_BASE_URL`, webhook payloads include absolute links.

## Robust Share Expiry (RS_*)

Robust Shares can optionally expire (`expires_hours`, `0 = never`). Expired shares return `410 Gone` for public access.

## Session Logout Timers (Admin vs Users)

The injected Droppr panel can enforce client-side logout timers (idle timeout + max session age) with separate values for admins vs non-admin users.

- Configure in the File Browser UI: **Settings** → **Droppr Session Settings** (admin-only; stored in `./database/droppr-settings.sqlite3`).
- Or set defaults via env vars (see `.env.example`).

## Start

```bash
cd /home/mlweb/mri-cooling-droppr
docker compose up -d
```

Local check:

```bash
curl -sS http://localhost:8098/ >/dev/null || true
docker logs droppr --tail 50
docker logs droppr-faststart --tail 50
```

On first run, File Browser will print a randomly generated admin password in the logs.

## Media smoke test (previews + replay)

Some clients rely on `HEAD` and conditional GETs for media endpoints like `/api/public/dl/...`. Droppr’s Nginx proxy normalizes these so previews and replays work reliably.

```bash
./scripts/smoke_media.sh 'https://droppr.coolmri.com/api/public/dl/<share>/<file>?inline=true'
```

## Files Location

- Upload/manage files in `./data/` (host path: `/home/mlweb/mri-cooling-droppr/data`).
- Persistent state is stored in `./database/` and `./config/`.

## Legacy Cloudflare Tunnel Fallback

Droppr has an independent Cloudflare tunnel configuration, but `droppr.coolmri.com` is currently served through the direct VPS bypass below. This host may still have `cloudflared-droppr` running as a short DNS-cache propagation fallback; fresh deploys keep it off unless the `tunnel` profile is requested.
The `cloudflared-droppr` container is gated behind the `tunnel` Compose profile, so a normal `docker compose up -d` does not start it.

Create the tunnel + config/credentials:

```bash
cd /home/mlweb/mri-cooling-droppr
./setup-cloudflare-tunnel.sh
```

Start the tunnel container:

```bash
cd /home/mlweb/mri-cooling-droppr
docker compose --profile tunnel up -d
```

For rollback, add the CNAME record printed by the setup script (`droppr` → `<TUNNEL_ID>.cfargotunnel.com`) and proxy it in Cloudflare.

## Direct VPS Bypass (No Cloudflare Data Path)

For large uploads and video streaming, `droppr.coolmri.com` is now pointed at the same VPS bypass pattern used by the Dropbox upload path. A test hostname is also available:

```text
https://droppr.coolmri.com
https://droppr.104.236.97.60.nip.io
```

Both proxy through VPS `104.236.97.60` to a reverse SSH tunnel back to local Droppr port `8098`. See `docs/VPS_BYPASS.md`.

Quick health check:

```bash
./scripts/smoke_stack.sh
# Isolated VPS-only check:
./scripts/smoke_vps_bypass.sh --range-url https://droppr.coolmri.com/api/robust-share/RS_droppr_direct_smoke/download/range-sentinel.txt
```

Install the optional recurring monitor with `deploy/droppr-direct-smoke.service` and `deploy/droppr-direct-smoke.timer`.
Use `./scripts/check_vps_bypass_soak.sh` after the monitor has run for 24 hours to decide when the Cloudflare fallback can be stopped.
