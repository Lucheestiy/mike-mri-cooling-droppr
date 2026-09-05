# Droppr Improvement Plan (Functionality Roadmap)

Date: 2026-01-15

## 0) Goals (What “better” means)

- **Recipients:** open a link, view/download media reliably, and (when requested) upload files **without needing an account**.
- **Admins:** create/manage share links quickly, set sensible defaults (expiry/password), and operate safely (timeouts, auditability).
- **Security:** links should be least-privilege (scoped), expirable, rate-limited, and resistant to traversal/abuse.
- **Operations:** predictable cleanup, simple configuration, and a few scripts/pages to manage the system.

## 1) Current State (Baseline)

Droppr is a Docker stack:

- **`droppr` (Nginx)**: reverse proxy + static public pages (`/gallery/<hash>`, `/share/<RS_…>`, `/analytics`, `/stream/<hash>`), plus upload retry fix (`override=true`) and `HEAD` normalization.
- **`droppr-app` (FileBrowser)**: authenticated admin UI, upload/manage files under `/srv`, and FileBrowser hash share links.
- **`droppr-media-server` (Flask)**: public gallery API for FileBrowser shares, robust shares (RS_*), proxy-video generation, analytics DB.
- **`droppr-faststart`**: post-processes new uploads for fast playback.

Sharing options today:

- **FileBrowser share hash** (`/gallery/<hash>`): great for simple sharing, but FileBrowser folder shares inherently expose the *parent* folder at `/api/public/share/<hash>`.
- **Robust Share** (`/share/<RS_…>`): safer public downloads (no FileBrowser auth required), supports “download selected”, password gating, and large files.

## 2) Improvements (Planned)

### A) Sharing Improvements

**A1. Robust Share expiration (RS_*)**

- **Problem:** Robust Shares are currently “forever” unless manually deleted.
- **Plan:** add optional `expires_at` to robust shares. Public endpoints return `410 Gone` when expired.
- **Admin UX:** allow setting “expires in N hours (0 = never)” at creation time in the Droppr panel.
- **Acceptance criteria:**
  - `expires_hours=0` creates a non-expiring share.
  - Expired shares cannot be browsed/downloaded (410).
  - Admin list shows `expires_at` and whether it’s expired.

**A2. Share management surface (Admin)**

- **Problem:** admins must use multiple places (FileBrowser shares page, Robust Share modal, scripts).
- **Plan:** add a small admin page that lists Robust Shares + Upload Requests with search, copy link, and revoke/delete actions.
- **Acceptance criteria:** admin can find and revoke a share/request in <30 seconds.

**A3. Share hygiene defaults**

- **Problem:** inconsistent expiry/password practices lead to “forever links” unintentionally.
- **Plan:** standardize defaults:
  - FileBrowser hash shares default expiry hours (already supported via Droppr “change expiry” button).
  - Robust Shares default expiry hours (new).
  - Optional password encouraged for sensitive shares.

### B) Upload Requests (Recipients upload without accounts)

**B1. Upload Request links (`/upload/<UR_…>`)**

- **Problem:** recipients currently can’t upload without FileBrowser login.
- **Plan:** create “Upload Requests” that generate a public link recipients can use to upload files to a specific folder.
- **Key features:**
  - Optional password gate (token-based session like Robust Shares).
  - Expiration (`expires_at`) and hard disable/revoke.
  - Constraints: max files, max per-file size, allowed extensions, overwrite policy.
  - Audit: record upload events (time/IP/UA, filenames, sizes).
- **Acceptance criteria:**
  - Admin can create a request from the FileBrowser UI for a selected folder.
  - Recipient can upload 1+ files via the public page.
  - Uploads land in the configured destination folder, with predictable naming.
  - Expired/revoked requests reject uploads (410/403).

**B2. Operational safety for uploads**

- **Plan:**
  - Nginx route for upload API has long timeouts and `proxy_request_buffering off`.
  - Media-server mounts `/srv` read-write, but only write paths reachable via a validated Upload Request.
  - Server-side filename/path validation (no traversal, no absolute paths, no backslashes).
  - Basic rate limiting (per-IP) on password verification + upload endpoints.

### C) Admin + User session controls (logout timers)

**C1. Configurable idle + max session time**

- **Problem:** tokens can effectively live “forever” on the client; this is risky on shared machines.
- **Plan:** implement client-side session enforcement in the injected Droppr panel:
  - **Idle timeout**: logout after N minutes without activity.
  - **Max session age**: logout after M minutes since login/session start, regardless of activity.
  - Separate values for **admin** vs **non-admin** users.
  - Warning modal before logout with “Stay signed in”.
- **Config:** stored as env vars on `droppr-media-server` and returned via `/api/droppr/client-config`.
- **Acceptance criteria:**
  - Admin/user timeouts are independent.
  - When a timeout triggers, Droppr clears local auth storage and forces re-login.

### D) Quality-of-life additions (Optional / Next)

- **Notifications:**
  - **Webhooks (implemented):** Upload Request events can POST to `DROPPR_UPLOAD_WEBHOOK_URL`.
  - **Email (optional):** send upload-complete alerts via SMTP (would need additional secrets + a mail provider).
- **Per-request “share back” (implemented):** after upload finishes, recipients can generate a view/download link back to the uploaded folder.
- **Virus scanning (optional):** ClamAV sidecar that scans Upload Request uploads and quarantines suspicious files.
- **Backup helper (implemented):** `scripts/backup_db.sh` archives key SQLite/config state (excludes uploaded media by default).
- **Auto-cleanup (optional):** scheduled purge of expired Upload Requests/Robust Shares + optional DB vacuuming.

## 3) Implementation Phases

**Phase 0 (Implement now)**
- B1/B2 Upload Requests (API + page + admin button)
- C1 Session logout controls (config endpoint + Droppr panel enforcement)
- A1 Robust Share expiration (DB + API + admin UI field)

**Phase 1 (Next)**
- A2 Admin management page (requests + robust shares)
- Notifications + “auto share back”

## 4) Rollout / Migration Notes

- Robust share expiry requires a lightweight SQLite migration (`ALTER TABLE` add column).
- Upload requests introduce a new SQLite DB file under `./database/`.
- Media-server will need write access to `./data` to store uploads (tight input validation is mandatory).

## 5) Status (Implemented in this repo)

- ✅ Phase 0 complete:
  - Upload Requests: API + admin button + public upload page
  - Session/logout timers (admin vs user)
  - Robust Share expiry
- ✅ Phase 1 complete:
  - Admin Link Manager page: `/manage` (lists robust shares + upload requests)
  - Upload Request webhooks (optional): set `DROPPR_UPLOAD_WEBHOOK_URL`
  - Per-request “share back”: upload page can generate a view/download link after upload
  - Session/logout settings editable from the File Browser **Settings** UI (admin-only)
