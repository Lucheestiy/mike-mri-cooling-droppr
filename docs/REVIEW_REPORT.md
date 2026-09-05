# Droppr Functionality Review Report

Date: 2026-01-15  
Environment: local `docker compose` stack on `http://localhost:8098`

## Executive Summary

Resolved the two classes of problems reported:

- **Robust Share public downloads** now work with **0 authentication** and download archives contain what was selected (no deep, confusing folder nesting).
- **Public routing hardening** prevents traversal-style URLs from falling through to FileBrowser and returning misleading `200/401` responses.

Also fixed a gallery correctness issue for **FileBrowser folder shares**: the gallery now starts inside the actual shared folder rather than crawling the parent directory (which could be extremely large).

## What Changed (High Level)

### Robust Shares (RS_*)
- Public file downloads no longer proxy FileBrowser auth-only endpoints; the media-server serves files directly from the mounted `/srv` data volume.
- `download-selected` accepts GET query param (with POST fallback in the UI) for better browser compatibility.
- Archive downloads send correct `Content-Length` (better progress, fewer “endless download” reports).
- `download-selected` archives are **flat** (no unwanted folder nesting).
- `download-selected` and `download-all` support `?format=zip` to download `.zip` archives (more familiar than `.tar`).
- UI also supports “Files” mode to start one download per file (browser may prompt to allow multiple downloads).
- If a share’s `title` is blank, it defaults to the source folder basename (avoids downloads named by the RS_ id).

### Gallery (FileBrowser hash shares)
- FileBrowser folder shares expose the **parent** folder at `/api/public/share/<hash>`. Droppr now detects the shared folder entry and defaults to that folder so the gallery doesn’t crawl huge parents like `/`.

### Nginx routing hardening
- Added an early guard that rejects traversal-style request URIs with `400` (because nginx normalizes dot-segments before location matching, which otherwise can cause fall-through to FileBrowser).

## Verification (Smoke Tests)

All smoke tests below passed after the fixes:

- File share gallery (video):  
  `./scripts/smoke_gallery.sh xAlRXqbI http://localhost:8098`
- Folder share gallery (mixed media):  
  `./scripts/smoke_gallery.sh ws747ECP http://localhost:8098`
- Robust Share public access + selected downloads + Range + traversal rejection:  
  `./scripts/smoke_robust_share.sh RS_C4eBJZ59VCGQZPXYQTiuYg http://localhost:8098`

## Key Behavioral Guarantees (Post-Fix)

- Robust Share recipients do not need FileBrowser login for public shares (`password_protected=false`).
- Robust Share:
  - single-file downloads support `Range` (resume/streaming)
  - `download-selected` includes **only** selected items and uses predictable, flat member names
  - `download-all` preserves folder structure with a top-level folder
- Traversal-style request URIs are rejected with `400` before routing.

## Known Risks / Follow-Ups (Optional)

- **UX:** “Files” mode may be blocked by browser popup/download protection; use ZIP/TAR if that happens.
- **Security posture:** FileBrowser folder shares inherently expose the parent directory to holders of the hash (Droppr UI now defaults into the shared folder, but `/api/public/dl/<hash>/...` can still access siblings). If strict folder-only access is required, prefer Robust Shares for sensitive data.
