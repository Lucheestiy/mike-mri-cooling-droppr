# Droppr (Login-Free Share Links)

Droppr is a lightweight file sharing UI for videos/pictures using File Browser. You log in to upload/manage files and create share links; recipients can view share links without an account.

## Sharing folders (avoid ZIP downloads)

File Browser’s “download” endpoint (`/api/public/dl/<hash>`) downloads folders as a `.zip`. Droppr redirects **bare** download links to the share UI (`/share/<hash>`) so recipients see pictures/videos in the browser.

If you ever need the `.zip` download, add any query string (example: `?download=1`) to bypass the redirect.

## Fast Start (Better Video Streaming)

Many iPhone `.mov` uploads store the `moov` atom at the end of the file, which makes browser playback feel extremely slow (it can look like the video won’t load until most of the file downloads).

This stack includes a `droppr-faststart` service that automatically fixes new `.mov/.mp4/.m4v` uploads by moving `moov` to the front **without re-encoding**.

## Upload Conflicts (HTTP 409)

File Browser returns HTTP `409` when uploading a file that already exists (common when a phone retries the same upload). Droppr now proxies uploads with `override=true` so retrying the same filename overwrites the existing file instead of failing.

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

The production tunnel config at `/home/mlweb/mri-cooling/cloudflare/config.yml` must include:

- `hostname: droppr.coolmri.com` -> `service: http://droppr:80`

After updating the config, restart the production tunnel:

```bash
cd /home/mlweb/mri-cooling
docker compose restart cloudflared
```

If `droppr.coolmri.com` does not resolve, add a DNS record in Cloudflare (or a wildcard `*.coolmri.com` record) pointing at the production tunnel.
