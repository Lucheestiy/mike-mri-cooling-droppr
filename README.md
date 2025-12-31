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

## Fast Start (Better Video Streaming)

Many iPhone `.mov` uploads store the `moov` atom at the end of the file, which makes browser playback feel extremely slow (it can look like the video won’t load until most of the file downloads).

This stack includes a `droppr-faststart` service that automatically fixes new `.mov/.mp4/.m4v` uploads by moving `moov` to the front **without re-encoding**.

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

## Public URL (Cloudflare Tunnel)

Droppr runs its own Cloudflare tunnel (separate from the production stack).

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

In Cloudflare DNS, add the CNAME record printed by the setup script (`droppr` → `<TUNNEL_ID>.cfargotunnel.com`).
