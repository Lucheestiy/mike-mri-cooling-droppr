# Droppr QA / Functionality Review Plan

This document is a **comprehensive test plan** for Droppr (FileBrowser + Nginx proxy + media-server + faststart). It is written to catch the kinds of issues you've been seeing: incorrect downloads, accidental auth requirements for recipients, fragile browser behavior, and confusing filenames/folder layouts.

## 1) Scope, Goal, and "Done" Criteria

**Goal:** recipients can use a public link to browse/download files reliably on desktop + mobile, without getting "authorization" errors, and downloads match what was selected.

**Done / acceptance criteria (must always hold):**
- Public recipients never need a login for **public shares** (FileBrowser hash shares and Robust Shares with `password_protected=false`).
- "Download selected" only contains the selected items, and is predictable to unpack.
- Single-file downloads support **Range** (resume / streaming) and **HEAD** (metadata).
- Folder downloads are clearly labeled (filename, and internal folder layout).
- Invalid share IDs do not "fall through" to FileBrowser auth pages (no confusing 401 login prompts).
- No path traversal is possible via public endpoints.

## 2) Architecture Map (What to Review)

### Services
- `droppr` (Nginx): routes public URLs, injects UI, applies `override=true` on uploads, normalizes `HEAD`.
- `droppr-app` (FileBrowser): file manager, share creation, raw file API.
- `droppr-media-server` (Flask/Gunicorn): gallery API, robust shares, analytics, proxy cache generation.
- `droppr-faststart`: post-processes new videos to make playback start quickly (moov atom, transcodes when needed).
- `cloudflared-droppr` (optional): Cloudflare tunnel for alternate deployment.

### Public surfaces
- **FileBrowser share hash** URLs: `/gallery/<hash>`, `/api/share/<hash>/...`, `/api/public/dl/...`
- **Robust Share** URLs: `/share/<RS_...>`, `/api/robust-share/<RS_...>/...`
- Player: `/player`, Stream gallery: `/stream/<hash>`

### Admin surfaces
- FileBrowser UI: `/`
- Admin share tools: `/api/share/...` (FileBrowser), `/api/droppr/...` (media-server)
- Analytics page: `/analytics`

## 3) Test Data (Use Small + Representative Fixtures)

Recommended test folders/files (already present in this repo’s `data/`):
- `data/testshare/` (PNG + iPhone `.mov`) -> good for gallery, preview, Range tests.
- `data/__agent_test__/test_extra_streams.mov` -> good for "weird" video stream layout edge cases.

If adding new fixtures, keep them small and name clearly:
- `data/__qa__/...`

## 4) Primary User Journeys (End-to-End)

### Journey A — Recipient: view a folder share (no login)
1. Open the share link.
2. Confirm UI loads without auth prompts.
3. Confirm folder contents match reality (file count, file sizes, nested folders).
4. Download 1 file, confirm correct filename, correct bytes, and can resume.

### Journey B — Recipient: download selected items (no login)
1. Select 2–3 items across subfolders.
2. Download selected.
3. Confirm archive contains **exactly** those items and nothing else.
4. Confirm archive structure is predictable:
   - For "Download Selected": flat filenames (no deep folder nesting).
   - For "Download All": preserves folder structure (includes top folder).

### Journey C — Recipient: watch a large video (iOS Safari + desktop)
1. Open gallery and play a video.
2. Seek/scrub forward and backward.
3. Replay after finishing (tests caching + conditional requests).

### Journey D — Admin: upload retry overwrite (no 409)
1. Upload a file.
2. Upload same filename again (simulate retry).
3. Confirm overwrite works (no `409 Conflict`), file matches last upload.

### Journey E — Admin: create and share robust share
1. Create robust share for a folder.
2. Open recipient link in private window (no cookies).
3. Download a file and download selected.

### Journey F — Admin: analytics + export
1. Open `/analytics` while logged in.
2. Confirm event list populates.
3. Export CSV and confirm format + content.

## 5) Test Matrix (Detailed)

### 5.1 Public browsing + downloads (FileBrowser share hash)
- `/api/public/dl/<hash>` redirects to `/gallery/<hash>` (no forced ZIP).
- `/gallery/<hash>` loads and displays items.
- `/api/share/<hash>/files` returns JSON with `inline_url` and `download_url`.
- `/api/share/<hash>/preview/<file>` returns `image/jpeg`.
- `/api/public/dl/<hash>/<file>?inline=true` supports:
  - `HEAD` (not 404)
  - `Range` (206)
  - no confusing 304 replay hangs

### 5.2 Robust Share (RS_*) public access
- `/share/<RS_...>` loads without auth.
- `/api/robust-share/<RS_...>/info` returns metadata and `password_protected`.
- `/api/robust-share/<RS_...>/files` returns folder/file listing.
- `/api/robust-share/<RS_...>/download/<path>`:
  - `HEAD` includes correct `Content-Length`
  - `Range: bytes=0-...` returns 206 with correct `Content-Range`
- `/api/robust-share/<RS_...>/download-all`:
  - `HEAD` returns `Content-Length`
  - `?format=zip` returns a `.zip` archive (more OS-friendly)
  - default tar contains top-level folder + full structure
- `/api/robust-share/<RS_...>/download-selected`:
  - contains **only selected items**
  - default tar member names are **flat** (no `/`)
  - `?format=zip` returns a `.zip` with the same flat layout

### 5.3 Robust Share password protection (RS_* protected)
- `/share/<RS_...>` shows password gate.
- Wrong password → 401 + rate limiting after N tries.
- Correct password → files load.
- Downloads require session token.
- Session token expiry behavior: predictable and documented.

### 5.4 Upload + overwrite behavior
- `POST/PUT /api/resources/...` always adds `override=true`.
- `DELETE /api/resources/...` does not add override.
- Very large upload does not time out (nginx + FileBrowser + client).
- Unicode filenames and spaces survive upload/delete/share.

### 5.5 Video processing + playback
- Newly uploaded iPhone videos become “faststart” quickly (moov atom moved).
- If HEVC/H.265 is unsupported, fallback transcode works and metadata shows change.
- `/api/proxy-cache/...` serves MP4 with Range and caching.
- `/player` works for iOS (stability).

### 5.6 Security + correctness
- Path traversal attempts fail on all public endpoints.
- Invalid share IDs return 400/404 (not FileBrowser login).
- No open redirect vulnerabilities in download endpoints.
- Download filenames cannot inject headers.

### 5.7 Performance + resilience
- Concurrency on thumbnails and proxy generation limited as configured.
- Nginx does not buffer large streams unexpectedly.
- Cloudflare does not cache "wrong" partials; replay works.

### 5.8 Operational / maintenance
- DB files in `database/` are backed up regularly.
- `docker compose up -d` is reproducible after reboot.
- Log locations and "how to debug" are documented.

## 6) Automation (Run These Often)

Default entrypoint:

- `scripts/smoke_stack.sh [--base-url URL] [--robust-share RS_ID] [--gallery HASH]`

Building blocks:

- `scripts/smoke_vps_bypass.sh [--range-url URL]`
- `scripts/smoke_robust_share.sh <robust-share-id> [base-url]`
- `scripts/smoke_gallery.sh <share-hash> [base-url]`
- `scripts/smoke_media.sh <public-media-url>`
- `scripts/check_vps_bypass_soak.sh`
- `scripts/stress_previews.sh <share-hash> [base-url] [concurrency] [count]`
- `scripts/stress_ranges.sh <share-hash> <file-path> [base-url] [concurrency] [count] [range-bytes]`

## 7) Reporting Format (What to Capture Each Review)

Create a report for each review run:
- Timestamp + git SHA
- Base URL tested (localhost vs production)
- Tests run (commands + scripts)
- Results (PASS/FAIL)
- Issues found (symptom, reproduction steps, suspected cause, fix)
- Follow-ups / risks
