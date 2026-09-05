(function () {
  if (window.__dropprPanelBooted) return;
  window.__dropprPanelBooted = true;

  var DROPPR_PANEL_VERSION = "31";
  var ANALYTICS_BTN_ID = "droppr-analytics-btn";
  var ANALYTICS_STYLE_ID = "droppr-analytics-style";
  var MANAGE_BTN_ID = "droppr-manage-btn";
  var MANAGE_STYLE_ID = "droppr-manage-style";
  var DROPPR_SETTINGS_STYLE_ID = "droppr-settings-style";
  var DROPPR_SETTINGS_CARD_ID = "droppr-settings-card";
  var SHARE_EXPIRE_STYLE_ID = "droppr-share-expire-style";
  var SHARE_EXPIRE_BTN_CLASS = "droppr-share-expire-btn";
  var SHARE_EXPIRE_STORAGE_KEY = "droppr_share_expire_hours";
  var AUTO_SHARE_STYLE_ID = "droppr-auto-share-style";
  var AUTO_SHARE_MODAL_ID = "droppr-auto-share-modal";
  var ICLOUD_WAIT_STYLE_ID = "droppr-icloud-wait-style";
  var ICLOUD_WAIT_MODAL_ID = "droppr-icloud-wait";
  var VIDEO_META_STYLE_ID = "droppr-video-meta-style";
  var VIDEO_META_PANEL_ID = "droppr-video-meta";
  var VIDEO_META_INLINE_ID = "droppr-video-meta-inline";
  var VIDEO_ROW_DETAILS_CLASS = "droppr-video-row-details";
  var VIDEO_DETAILS_ROW_CLASS = "droppr-video-details-row";
  var DEBUG_BADGE_ID = "droppr-debug-badge";
  var THEME_TOGGLE_BTN_ID = "droppr-theme-toggle";
  var THEME_PREFS_KEY = "droppr_gallery_prefs";
  var STREAM_BTN_ID = "droppr-stream-btn";
  var STREAM_BTN_STYLE_ID = "droppr-stream-style";
  var STREAM_SHARE_BTN_CLASS = "droppr-stream-share-btn";
  var STREAM_SHARE_STYLE_ID = "droppr-stream-share-style";
  var FILES_STREAM_SHARE_BTN_CLASS = "droppr-files-stream-share-btn";
  var FILES_STREAM_SHARE_STYLE_ID = "droppr-files-stream-share-style";
  var QUICK_SHARE_BTN_CLASS = "droppr-quick-share-btn";
  var QUICK_SHARE_STYLE_ID = "droppr-quick-share-style";
  var ROBUST_SHARE_BTN_CLASS = "droppr-robust-share-btn";
  var ROBUST_SHARE_STYLE_ID = "droppr-robust-share-style";
  var ROBUST_SHARE_MODAL_ID = "droppr-robust-share-modal";
  var ROBUST_SHARE_EXPIRE_STORAGE_KEY = "droppr_robust_share_expire_hours";
  var UPLOAD_REQUEST_BTN_CLASS = "droppr-upload-request-btn";
  var UPLOAD_REQUEST_STYLE_ID = "droppr-upload-request-style";
  var UPLOAD_REQUEST_FAB_ID = "droppr-upload-request-fab";
  var UPLOAD_REQUEST_MENU_ID = "droppr-upload-request-menu-item";
  var UPLOAD_REQUEST_MODAL_ID = "droppr-upload-request-modal";
  var UPLOAD_REQUEST_EXPIRE_STORAGE_KEY = "droppr_upload_request_expire_hours";
  var SESSION_STYLE_ID = "droppr-session-style";
  var SESSION_MODAL_ID = "droppr-session-modal";
  var SESSION_TOKEN_HASH_KEY = "droppr_session_token_hash";
  var SESSION_START_MS_KEY = "droppr_session_start_ms";
  var SESSION_LAST_ACTIVITY_MS_KEY = "droppr_session_last_activity_ms";
  var SESSION_IS_ADMIN_KEY = "droppr_session_is_admin";

  var uploadBatch = null;
  var tusUploads = {};
  var lastAutoSharedPath = null;
  var lastAutoSharedAt = 0;
  var fileInputBypass = false;
  var fileInputGate = null;

  var videoMetaCache = {};
  var videoMetaInFlight = {};
  var videoMetaActivePath = null;
  var videoMetaDismissedPath = null;
  var videoMetaPollTimer = null;
  var filesVideoHydrateTimer = null;
  var filesVideoLastPathname = null;
  var videoMetaDebugStats = { ok: 0, notFound: 0, unauth: 0, other: 0 };
  var manageAdminCheckedAt = 0;
  var manageAdminCheckInFlight = false;
  var sessionSettingsAdminCheckedAt = 0;
  var sessionSettingsAdminCheckInFlight = false;
  var uploadRequestMenuLastEnsureAt = 0;

  function nowMs() {
    return new Date().getTime();
  }

  function isDropprDebugEnabled() {
    try {
      return /(?:^|[?&])dropprDebug=1(?:&|$)/.test(String(window.location && window.location.search) || "");
    } catch (e) {
      return false;
    }
  }

  function ensureDebugBadge() {
    if (!isDropprDebugEnabled()) return null;

    var existing = document.getElementById(DEBUG_BADGE_ID);
    if (existing) return existing;

    var el = document.createElement("div");
    el.id = DEBUG_BADGE_ID;
    el.style.cssText =
      "position:fixed;left:10px;bottom:10px;z-index:2147483647;" +
      "max-width:min(92vw, 520px);" +
      "padding:8px 10px;border-radius:12px;" +
      "background:rgba(2,6,23,0.88);border:1px solid rgba(255,255,255,0.14);" +
      "color:rgba(241,245,249,0.96);" +
      "font:12px/1.35 Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;" +
      "box-shadow:0 18px 40px -18px rgba(0,0,0,0.75);" +
      "user-select:text;cursor:text;";
    el.textContent = "Droppr enhancements v" + DROPPR_PANEL_VERSION + " loading…";
    document.body.appendChild(el);
    return el;
  }

  function setDebugBadge(text) {
    var badge = ensureDebugBadge();
    if (!badge) return;
    badge.textContent = text;
  }

  function getCookie(name) {
    var m = (document.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
    return m ? m[1] : null;
  }

  function getAuthToken() {
    try {
      var jwt = localStorage.getItem("jwt");
      if (jwt) return jwt;
    } catch (e) {
      // ignore
    }

    var auth = getCookie("auth");
    if (auth) {
      try {
        return decodeURIComponent(auth);
      } catch (e2) {
        return auth;
      }
    }

    return null;
  }

  function isLoggedIn() {
    return !!getAuthToken();
  }

  function ensureAnalyticsStyles() {
    if (document.getElementById(ANALYTICS_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = ANALYTICS_STYLE_ID;
    style.textContent =
      "#" + ANALYTICS_BTN_ID + " {\n" +
      "  position: fixed;\n" +
      "  right: 18px;\n" +
      "  bottom: 18px;\n" +
      "  z-index: 2147483000;\n" +
      "  display: inline-flex;\n" +
      "  align-items: center;\n" +
      "  gap: 8px;\n" +
      "  padding: 10px 12px;\n" +
      "  border-radius: 999px;\n" +
      "  background: rgba(99, 102, 241, 0.95);\n" +
      "  color: #fff !important;\n" +
      "  text-decoration: none !important;\n" +
      "  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;\n" +
      "  font-weight: 700;\n" +
      "  letter-spacing: -0.01em;\n" +
      "  box-shadow: 0 18px 40px -18px rgba(0,0,0,0.65);\n" +
      "  border: 1px solid rgba(255,255,255,0.18);\n" +
      "  user-select: none;\n" +
      "}\n" +
      "#" + ANALYTICS_BTN_ID + ":hover {\n" +
      "  background: rgba(79, 70, 229, 0.98);\n" +
      "  transform: translateY(-1px);\n" +
      "}\n" +
      "#" + ANALYTICS_BTN_ID + " .icon {\n" +
      "  width: 18px;\n" +
      "  height: 18px;\n" +
      "  display: inline-block;\n" +
      "}\n" +
      "#" + ANALYTICS_BTN_ID + " .label {\n" +
      "  font-size: 14px;\n" +
      "  line-height: 1;\n" +
      "}\n";
    document.head.appendChild(style);
  }

  function ensureAnalyticsButton() {
    var existing = document.getElementById(ANALYTICS_BTN_ID);
    if (!isLoggedIn()) {
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
      return;
    }

    if (existing) return;

    ensureAnalyticsStyles();

    var a = document.createElement("a");
    a.id = ANALYTICS_BTN_ID;
    a.href = "/analytics";
    a.target = "_blank";
    a.rel = "noopener";
    a.title = "Droppr Analytics";
    a.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M3 3h2v18H3V3zm4 10h2v8H7v-8zm4-6h2v14h-2V7zm4 4h2v10h-2V11zm4-7h2v17h-2V4z"/>' +
      "</svg>" +
      '<span class="label">Analytics</span>';

    document.body.appendChild(a);
  }

  // ============ MANAGER BUTTON ============
  function ensureManageStyles() {
    if (document.getElementById(MANAGE_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = MANAGE_STYLE_ID;
    style.textContent =
      "#" + MANAGE_BTN_ID + " {\n" +
      "  position: fixed;\n" +
      "  right: 18px;\n" +
      "  bottom: 132px;\n" +
      "  z-index: 2147483000;\n" +
      "  display: inline-flex;\n" +
      "  align-items: center;\n" +
      "  gap: 8px;\n" +
      "  padding: 10px 12px;\n" +
      "  border-radius: 999px;\n" +
      "  background: rgba(16, 185, 129, 0.95);\n" +
      "  color: #04120c !important;\n" +
      "  text-decoration: none !important;\n" +
      "  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;\n" +
      "  font-weight: 800;\n" +
      "  letter-spacing: -0.01em;\n" +
      "  box-shadow: 0 18px 40px -18px rgba(0,0,0,0.65);\n" +
      "  border: 1px solid rgba(255,255,255,0.18);\n" +
      "  user-select: none;\n" +
      "}\n" +
      "#" + MANAGE_BTN_ID + ":hover {\n" +
      "  background: rgba(5, 150, 105, 0.98);\n" +
      "  transform: translateY(-1px);\n" +
      "}\n" +
      "#" + MANAGE_BTN_ID + " .icon {\n" +
      "  width: 18px;\n" +
      "  height: 18px;\n" +
      "  display: inline-block;\n" +
      "}\n" +
      "#" + MANAGE_BTN_ID + " .label {\n" +
      "  font-size: 14px;\n" +
      "  line-height: 1;\n" +
      "}\n";
    document.head.appendChild(style);
  }

  function ensureManageButton() {
    var existing = document.getElementById(MANAGE_BTN_ID);
    if (!isLoggedIn()) {
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
      return;
    }

    var token = getAuthToken();
    var storedIsAdmin = null;
    try {
      storedIsAdmin = localStorage.getItem(SESSION_IS_ADMIN_KEY);
    } catch (e) {
      storedIsAdmin = null;
    }

    if (storedIsAdmin === "0") {
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
      return;
    }

    if (storedIsAdmin !== "1") {
      // Unknown: best-effort check, but do not spam.
      var now = nowMs();
      if (token && !manageAdminCheckInFlight && now - manageAdminCheckedAt > 30000) {
        manageAdminCheckInFlight = true;
        manageAdminCheckedAt = now;
        detectIsAdmin(token)
          .then(function (v) {
            try {
              localStorage.setItem(SESSION_IS_ADMIN_KEY, v ? "1" : "0");
            } catch (e2) {}
          })
          .catch(function () {})
          .finally(function () {
            manageAdminCheckInFlight = false;
            ensureManageButton();
          });
      }

      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
      return;
    }

    if (existing) return;

    ensureManageStyles();

    var a = document.createElement("a");
    a.id = MANAGE_BTN_ID;
    a.href = "/manage";
    a.target = "_blank";
    a.rel = "noopener";
    a.title = "Droppr Manager (Robust Shares + File Requests)";
    a.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M10.59 13.41L9.17 12l4.24-4.24l1.41 1.41L10.59 13.41zM7.05 14.83l-1.41-1.41l2.12-2.12l1.41 1.41l-2.12 2.12zM12 22a10 10 0 1 1 0-20a10 10 0 0 1 0 20Zm0-18a8 8 0 1 0 0 16a8 8 0 0 0 0-16Z"/>' +
      "</svg>" +
      '<span class="label">Manager</span>';

    document.body.appendChild(a);
  }

  // ============ STREAM GALLERY BUTTON ============
  function ensureStreamButtonStyles() {
    if (document.getElementById(STREAM_BTN_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STREAM_BTN_STYLE_ID;
    style.textContent =
      "#" + STREAM_BTN_ID + " {\n" +
      "  position: fixed;\n" +
      "  bottom: 76px;\n" +
      "  right: 16px;\n" +
      "  z-index: 9999;\n" +
      "  display: flex;\n" +
      "  align-items: center;\n" +
      "  gap: 6px;\n" +
      "  padding: 10px 14px;\n" +
      "  background: #6366f1;\n" +
      "  color: #fff;\n" +
      "  border: none;\n" +
      "  border-radius: 24px;\n" +
      "  font-size: 13px;\n" +
      "  font-weight: 600;\n" +
      "  text-decoration: none;\n" +
      "  cursor: pointer;\n" +
      "  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);\n" +
      "  transition: all 0.2s ease;\n" +
      "}\n" +
      "#" + STREAM_BTN_ID + ":hover {\n" +
      "  background: #818cf8;\n" +
      "  transform: translateY(-2px);\n" +
      "  box-shadow: 0 6px 16px rgba(99, 102, 241, 0.5);\n" +
      "}\n" +
      "#" + STREAM_BTN_ID + " .icon {\n" +
      "  width: 18px;\n" +
      "  height: 18px;\n" +
      "}\n" +
      "#" + STREAM_BTN_ID + " .label {\n" +
      "  line-height: 1;\n" +
      "}\n";
    document.head.appendChild(style);
  }

  function getShareHashFromUrl() {
    var path = window.location.pathname || "";
    // Match /gallery/<hash> or /media/<hash>
    var m = path.match(/^\/(?:gallery|media)\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    // Match share param in query string
    var params = new URLSearchParams(window.location.search);
    var share = params.get("share");
    if (share && /^[A-Za-z0-9_-]+$/.test(share)) return share;
    return null;
  }

  function ensureStreamButton() {
    var existing = document.getElementById(STREAM_BTN_ID);
    var shareHash = getShareHashFromUrl();
    
    // Only show on gallery pages with a share hash
    if (!shareHash) {
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
      return;
    }

    if (existing) {
      // Update href in case hash changed
      existing.href = "/stream/" + shareHash;
      return;
    }

    ensureStreamButtonStyles();

    var a = document.createElement("a");
    a.id = STREAM_BTN_ID;
    a.href = "/stream/" + shareHash;
    a.target = "_blank";
    a.rel = "noopener";
    a.title = "Open Stream Gallery (optimized video player for large files)";
    a.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M8 5v14l11-7z"/>' +
      "</svg>" +
      '<span class="label">Stream</span>';

    document.body.appendChild(a);
  }

  // ============ THEME TOGGLE ============
  function loadThemePrefs() {
    try {
      return JSON.parse(localStorage.getItem(THEME_PREFS_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveThemePrefs(prefs) {
    try {
      var existing = loadThemePrefs();
      for (var key in prefs) {
        existing[key] = prefs[key];
      }
      localStorage.setItem(THEME_PREFS_KEY, JSON.stringify(existing));
    } catch (e) {
      // ignore
    }
  }

  function getTheme() {
    var prefs = loadThemePrefs();
    return prefs.theme || "dark";
  }

  function setTheme(theme) {
    var isDark = theme === "dark";

    // Set on both html and body for maximum compatibility
    document.documentElement.setAttribute("data-theme", theme);
    if (document.body) document.body.setAttribute("data-theme", theme);

    // Also add/remove class for FileBrowser Vue compatibility
    if (isDark) {
      document.documentElement.classList.remove("light-theme");
      if (document.body) document.body.classList.remove("light-theme");
    } else {
      document.documentElement.classList.add("light-theme");
      if (document.body) document.body.classList.add("light-theme");
    }

    // FileBrowser's built-in theme variables use `:root.dark` (html.dark).
    // Keep it in sync so dialogs/menus/overlays follow the selected theme.
    if (isDark) {
      document.documentElement.classList.add("dark");
      if (document.body) document.body.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
      if (document.body) document.body.classList.remove("dark");
    }

    var btn = document.getElementById(THEME_TOGGLE_BTN_ID);
    if (btn) {
      btn.textContent = isDark ? "🌙" : "☀️";
      btn.title = isDark ? "Switch to light theme" : "Switch to dark theme";
      // Update button colors based on theme
      btn.style.background = isDark ? "#1e293b" : "#ffffff";
      btn.style.color = isDark ? "#f1f5f9" : "#1e293b";
      btn.style.borderColor = isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)";
    }

    // Fix search input placeholder via JavaScript for iOS
    fixPlaceholderColors(isDark);

    saveThemePrefs({ theme: theme });
  }

  function fixPlaceholderColors(isDark) {
    // Inject a style tag to force placeholder colors
    var styleId = "droppr-placeholder-fix";
    var existing = document.getElementById(styleId);
    if (existing) {
      existing.parentNode.removeChild(existing);
    }

    var placeholderColor = isDark ? "#94a3b8" : "#475569";
    var style = document.createElement("style");
    style.id = styleId;
    style.textContent =
      "input::placeholder, input::-webkit-input-placeholder { " +
      "  color: " + placeholderColor + " !important; " +
      "  opacity: 1 !important; " +
      "  -webkit-text-fill-color: " + placeholderColor + " !important; " +
      "} " +
      "input::-moz-placeholder { " +
      "  color: " + placeholderColor + " !important; " +
      "  opacity: 1 !important; " +
      "} " +
      "input:-ms-input-placeholder { " +
      "  color: " + placeholderColor + " !important; " +
      "} ";
    document.head.appendChild(style);
  }

  function toggleTheme() {
    var current = getTheme();
    var newTheme = current === "dark" ? "light" : "dark";
    // Debug: show what's happening
    console.log("Droppr: Toggling theme from " + current + " to " + newTheme);
    setTheme(newTheme);
  }

  function ensureThemeToggle() {
    var existing = document.getElementById(THEME_TOGGLE_BTN_ID);
    if (existing) return;

    // Initialize theme from prefs
    var theme = getTheme();
    // Apply immediately (also sync FileBrowser's `:root.dark` class)
    setTheme(theme);

    var btn = document.createElement("button");
    btn.id = THEME_TOGGLE_BTN_ID;
    btn.type = "button";
    btn.textContent = theme === "dark" ? "🌙" : "☀️";
    btn.title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
    btn.style.cssText =
      "position:fixed;right:18px;bottom:70px;z-index:2147483000;" +
      "display:inline-flex;align-items:center;justify-content:center;" +
      "width:44px;height:44px;border-radius:50%;" +
      "background:var(--card-bg,#1e293b);color:var(--text-primary,#f1f5f9);" +
      "font-size:20px;box-shadow:0 4px 12px rgba(0,0,0,0.25);" +
      "border:1px solid var(--border-color,rgba(255,255,255,0.1));" +
      "cursor:pointer;-webkit-tap-highlight-color:transparent;" +
      "touch-action:manipulation;user-select:none;";

    // Use click event - works on iOS when button has proper touch-action
    btn.addEventListener("click", function(e) {
      e.preventDefault();
      toggleTheme();
    }, false);

    document.body.appendChild(btn);

    // Ensure button styling matches applied theme (setTheme may have run before the button existed)
    setTheme(theme);
  }

  function ensureVideoMetaStyles() {
    if (document.getElementById(VIDEO_META_STYLE_ID)) return;

    var style = document.createElement("style");
    style.id = VIDEO_META_STYLE_ID;
    style.textContent =
      "#" + VIDEO_META_PANEL_ID + " {\n" +
      "  position: fixed;\n" +
      "  right: 18px;\n" +
      "  bottom: 74px;\n" +
      "  z-index: 2147482999;\n" +
      "  width: min(460px, calc(100vw - 36px));\n" +
      "  background: var(--droppr-overlay-bg, rgba(15, 23, 42, 0.92));\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.14));\n" +
      "  border-radius: 14px;\n" +
      "  box-shadow: 0 18px 40px -18px rgba(0,0,0,0.75);\n" +
      "  padding: 12px;\n" +
      "  color: var(--droppr-overlay-text, #f1f5f9);\n" +
      "  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;\n" +
      "  display: none;\n" +
      "}\n" +
      "#" + VIDEO_META_PANEL_ID + " .hdr {\n" +
      "  display: flex;\n" +
      "  align-items: center;\n" +
      "  justify-content: space-between;\n" +
      "  gap: 10px;\n" +
      "}\n" +
      "#" + VIDEO_META_PANEL_ID + " .title {\n" +
      "  font-weight: 800;\n" +
      "  font-size: 13px;\n" +
      "  letter-spacing: -0.01em;\n" +
      "}\n" +
      "#" + VIDEO_META_PANEL_ID + " .close {\n" +
      "  appearance: none;\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.2));\n" +
      "  background: var(--hover-bg, rgba(255,255,255,0.08));\n" +
      "  color: var(--text-primary, #fff);\n" +
      "  width: 28px;\n" +
      "  height: 28px;\n" +
      "  border-radius: 10px;\n" +
      "  cursor: pointer;\n" +
      "  font-weight: 800;\n" +
      "}\n" +
      "#" + VIDEO_META_PANEL_ID + " .path {\n" +
      "  margin-top: 6px;\n" +
      "  font-size: 12px;\n" +
      "  opacity: 0.82;\n" +
      "  word-break: break-word;\n" +
      "}\n" +
      "#" + VIDEO_META_PANEL_ID + " .grid {\n" +
      "  margin-top: 10px;\n" +
      "  display: grid;\n" +
      "  gap: 7px;\n" +
      "}\n" +
      "#" + VIDEO_META_PANEL_ID + " .row {\n" +
      "  display: flex;\n" +
      "  align-items: baseline;\n" +
      "  justify-content: space-between;\n" +
      "  gap: 12px;\n" +
      "  font-size: 12px;\n" +
      "}\n" +
      "#" + VIDEO_META_PANEL_ID + " .k {\n" +
      "  opacity: 0.78;\n" +
      "  white-space: nowrap;\n" +
      "}\n" +
      "#" + VIDEO_META_PANEL_ID + " .v {\n" +
      "  text-align: right;\n" +
      "  overflow: hidden;\n" +
      "  text-overflow: ellipsis;\n" +
      "}\n" +
      "#" + VIDEO_META_INLINE_ID + " {\n" +
      "  margin-top: 10px;\n" +
      "  padding: 10px 12px;\n" +
      "  border-radius: 12px;\n" +
      "  background: var(--droppr-overlay-bg-soft, rgba(15, 23, 42, 0.85));\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.14));\n" +
      "  box-shadow: 0 12px 26px -18px rgba(0,0,0,0.75);\n" +
      "  color: var(--droppr-overlay-text, #f1f5f9);\n" +
      "  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;\n" +
      "  font-size: 12px;\n" +
      "  line-height: 1.35;\n" +
      "}\n" +
      "#" + VIDEO_META_INLINE_ID + " .line {\n" +
      "  display: block;\n" +
      "  opacity: 0.95;\n" +
      "  white-space: nowrap;\n" +
      "  overflow: hidden;\n" +
      "  text-overflow: ellipsis;\n" +
      "}\n" +
      "#" + VIDEO_META_INLINE_ID + " .muted {\n" +
      "  opacity: 0.75;\n" +
      "}\n" +
      "." + VIDEO_ROW_DETAILS_CLASS + " {\n" +
      "  margin-top: 6px;\n" +
      "  padding: 8px 10px;\n" +
      "  border-radius: 12px;\n" +
      "  background: var(--droppr-overlay-bg-subtle, rgba(15, 23, 42, 0.78));\n" +
      "  border: 1px solid var(--droppr-overlay-border-soft, rgba(148, 163, 184, 0.22));\n" +
      "  color: var(--droppr-overlay-text, rgba(248, 250, 252, 0.98)) !important;\n" +
      "  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;\n" +
      "  font-size: 11px;\n" +
      "  line-height: 1.35;\n" +
      "  backdrop-filter: blur(8px);\n" +
      "  -webkit-backdrop-filter: blur(8px);\n" +
      "  user-select: text;\n" +
      "  cursor: text;\n" +
      "}\n" +
      "." + VIDEO_ROW_DETAILS_CLASS + " .line {\n" +
      "  display: block;\n" +
      "  color: var(--droppr-overlay-text, rgba(248, 250, 252, 0.98)) !important;\n" +
      "  white-space: normal;\n" +
      "  overflow-wrap: anywhere;\n" +
      "  word-break: break-word;\n" +
      "}\n" +
      "." + VIDEO_ROW_DETAILS_CLASS + " .muted {\n" +
      "  opacity: 0.88;\n" +
      "  color: var(--droppr-overlay-muted, rgba(203, 213, 225, 0.96)) !important;\n" +
      "}\n" +
      "." + VIDEO_DETAILS_ROW_CLASS + " {\n" +
      "  user-select: text;\n" +
      "}\n" +
      "#listing:not(.list) ." + VIDEO_ROW_DETAILS_CLASS + " {\n" +
      "  position: static;\n" +
      "  margin-top: 4px;\n" +
      "  padding: 6px 8px;\n" +
      "  font-size: 10px;\n" +
      "  line-height: 1.25;\n" +
      "  background: var(--droppr-overlay-bg, rgba(2, 6, 23, 0.84));\n" +
      "  border-color: var(--droppr-overlay-border-soft, rgba(148, 163, 184, 0.24));\n" +
      "}\n";

    document.head.appendChild(style);
  }

  function ensureVideoMetaPanel() {
    var existing = document.getElementById(VIDEO_META_PANEL_ID);
    if (existing) return existing;

    ensureVideoMetaStyles();

    var panel = document.createElement("div");
    panel.id = VIDEO_META_PANEL_ID;
    panel.innerHTML =
      '<div class="hdr">' +
      '<div class="title">Video details</div>' +
      '<button class="close" type="button" aria-label="Hide">×</button>' +
      "</div>" +
      '<div id="droppr-video-meta-path" class="path"></div>' +
      '<div class="grid">' +
      '<div class="row"><div class="k">Status</div><div id="droppr-video-meta-status" class="v"></div></div>' +
      '<div class="row"><div class="k">Uploaded</div><div id="droppr-video-meta-uploaded" class="v"></div></div>' +
      '<div class="row"><div class="k">Processed at</div><div id="droppr-video-meta-processed-at" class="v"></div></div>' +
      '<div class="row"><div class="k">Original</div><div id="droppr-video-meta-original" class="v"></div></div>' +
      '<div class="row"><div class="k">After</div><div id="droppr-video-meta-processed" class="v"></div></div>' +
      '<div class="row"><div class="k">Action</div><div id="droppr-video-meta-action" class="v"></div></div>' +
      "</div>";

    panel.querySelector(".close").addEventListener("click", function () {
      videoMetaDismissedPath = videoMetaActivePath || videoMetaDismissedPath;
      panel.style.display = "none";
    });

    document.body.appendChild(panel);
    return panel;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var v = bytes;
    var i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    var digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
    return v.toFixed(digits) + " " + units[i];
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    var s = Math.floor(seconds);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
    return m + ":" + String(sec).padStart(2, "0");
  }

  function actionLabel(action) {
    var a = String(action || "").toLowerCase();
    if (a === "transcode_hevc_to_h264") return "Transcoded HEVC → H.264";
    if (a === "fix_video_errors_extra_streams") return "Re-encoded (removed extra streams)";
    if (a === "fix_video_errors_timestamp") return "Re-encoded (fixed timestamps)";
    if (a === "faststart") return "Faststart (moov moved)";
    if (a === "already_faststart") return "Already faststart";
    if (a === "none") return "No changes";
    return action ? String(action) : "";
  }

  function safeToIso(tsSeconds) {
    if (tsSeconds == null) return "";
    var n = parseInt(String(tsSeconds), 10);
    if (isNaN(n) || n <= 0) return "";
    try {
      return new Date(n * 1000).toLocaleString();
    } catch (e) {
      return "";
    }
  }

  function renderMetaSummary(meta, sizeOverride) {
    if (!meta || typeof meta !== "object") {
      if (Number.isFinite(sizeOverride) && sizeOverride > 0) return formatBytes(sizeOverride);
      return "—";
    }

    var size = null;
    if (Number.isFinite(sizeOverride) && sizeOverride > 0) size = sizeOverride;
    else {
      var sz = Number(meta.size);
      size = Number.isFinite(sz) && sz > 0 ? sz : null;
    }

    var v = meta.video && typeof meta.video === "object" ? meta.video : {};
    var a = meta.audio && typeof meta.audio === "object" ? meta.audio : {};

    var w = parseInt(String(v.display_width || v.width || ""), 10);
    var h = parseInt(String(v.display_height || v.height || ""), 10);
    var res = !isNaN(w) && !isNaN(h) && w > 0 && h > 0 ? w + "×" + h : "";

    var vcodec = v.codec ? String(v.codec).toUpperCase() : "";
    var acodec = a.codec ? String(a.codec).toUpperCase() : "";
    var codecs = vcodec ? (acodec ? vcodec + "/" + acodec : vcodec) : (acodec || "");

    var dur = Number(meta.duration);
    var durText = Number.isFinite(dur) && dur > 0 ? formatDuration(dur) : "";

    var fps = Number(v.fps);
    var fpsText = Number.isFinite(fps) && fps > 0 ? String(Math.round(fps * 100) / 100) + "fps" : "";

    var out = [];
    if (size) out.push(formatBytes(size));
    if (res) out.push(res);
    if (codecs) out.push(codecs);
    if (durText) out.push(durText);
    if (fpsText) out.push(fpsText);
    return out.length ? out.join(" • ") : "—";
  }

  function isLikelyVideoPath(path) {
    var s = String(path || "").toLowerCase();
    return s.endsWith(".mp4") || s.endsWith(".mov") || s.endsWith(".m4v");
  }

  function isFilesPage() {
    var p = String((window.location && window.location.pathname) || "");
    return p === "/files" || p.indexOf("/files/") === 0;
  }

  function getFilesListingLayout() {
    var listing = document.getElementById("listing");
    if (listing && listing.classList && listing.classList.contains("list")) return "list";
    return "grid";
  }

  function getFilesDirPath() {
    var p = String((window.location && window.location.pathname) || "");
    if (p === "/files") return "/";
    if (p.indexOf("/files/") !== 0) return "/";

    var rest = p.substring("/files".length);
    if (!rest) return "/";

    var decoded = rest;
    try {
      decoded = decodeURIComponent(rest);
    } catch (e) {
      decoded = rest;
    }
    return normalizePathEncoded(decoded);
  }

  function joinPaths(dirPath, name) {
    var d = normalizePathEncoded(dirPath);
    var n = String(name || "").trim();
    if (!n) return null;
    n = n.replace(/^\/+/, "");

    var combined = d === "/" ? ("/" + n) : (d + "/" + n);
    return normalizePathEncoded(combined);
  }

  function extractFilesPathFromHref(href) {
    var u = normalizeUrl(href);
    if (!u) return null;

    var raw = extractApiPath(u.toString(), "/files");
    if (raw == null && u.hash) {
      // Some routers use hash-based URLs.
      var h = String(u.hash || "");
      if (h.indexOf("#/files") === 0) raw = h.substring("#/files".length);
    }
    if (raw == null) return null;

    var normalized = normalizePathEncoded(raw);
    var decoded = normalized;
    try {
      decoded = decodeURIComponent(normalized);
    } catch (e) {
      decoded = normalized;
    }
    return normalizePathEncoded(decoded);
  }

  function encodePathSegmentsForApi(decodedPath) {
    var s = String(decodedPath || "");
    if (s && s.charAt(0) !== "/") s = "/" + s;
    s = s.replace(/^\/+/, "/");
    var parts = s.split("/");
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      parts[i] = encodeURIComponent(parts[i]);
    }
    return parts.join("/");
  }

  function getSelectedFilesRowEl() {
    var listing = document.getElementById("listing") || document.getElementById("app") || document.body;
    if (!listing || !listing.querySelector) return null;

    return (
      listing.querySelector(".row.list-item.active") ||
      listing.querySelector(".v-list-item--active") ||
      listing.querySelector("tr.active, tr.selected") ||
      listing.querySelector(".item.active, .item.selected") ||
      listing.querySelector(".file.active, .file.selected") ||
      listing.querySelector('[aria-selected="true"]')
    );
  }

  function extractSelectedPathFromFilesRow(rowEl) {
    if (!rowEl || !rowEl.querySelectorAll) return null;

    var dirPath = getFilesDirPath();
    var bestPath = null;

    var anchors = rowEl.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length; i++) {
      var href = anchors[i] && anchors[i].getAttribute ? anchors[i].getAttribute("href") : null;
      var p = extractFilesPathFromHref(href);
      if (!p) continue;
      if (p === dirPath) continue;
      if (!bestPath || p.length > bestPath.length) bestPath = p;
    }

    if (bestPath) return bestPath;

    var nameEl =
      rowEl.querySelector(".name") ||
      rowEl.querySelector(".v-list-item__title") ||
      rowEl.querySelector(".filename") ||
      rowEl.querySelector(".file-name") ||
      null;
    var nameText = nameEl && nameEl.textContent ? String(nameEl.textContent || "").trim() : "";
    if (!nameText) {
      // Fallback: pick the first reasonable text node.
      var candidates = rowEl.querySelectorAll("a, span, div, td, p");
      for (var c = 0; c < candidates.length; c++) {
        var t = String(candidates[c].textContent || "").trim();
        if (!t) continue;
        if (t.length > 200) continue;
        // Skip common size/time patterns.
        if (/^\d+(\.\d+)?\s*(B|KB|MB|GB|TB)$/i.test(t)) continue;
        if (/ago$/.test(t)) continue;
        nameText = t;
        break;
      }
    }

    if (!nameText) return null;
    return joinPaths(dirPath, nameText);
  }

  function findVideoNameElementInRow(rowEl) {
    if (!rowEl || !rowEl.querySelectorAll) return null;

    var candidates = rowEl.querySelectorAll("a, span, div, td, p");
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!el || !el.textContent) continue;
      if (el.id === VIDEO_META_INLINE_ID) continue;
      if (el.classList && el.classList.contains(VIDEO_ROW_DETAILS_CLASS)) continue;
      try {
        if (el.closest && el.closest("#" + VIDEO_META_INLINE_ID)) continue;
        if (el.closest && el.closest("." + VIDEO_ROW_DETAILS_CLASS)) continue;
      } catch (e) {
        // ignore
      }

      var txt = String(el.textContent || "").trim();
      if (!txt) continue;
      if (txt.length > 200) continue;
      if (!isLikelyVideoPath(txt)) continue;
      return el;
    }

    return null;
  }

  function extractVideoPathFromRow(rowEl, nameText) {
    if (!rowEl) return null;

    var anchors = rowEl.querySelectorAll ? rowEl.querySelectorAll("a[href]") : [];
    for (var i = 0; i < anchors.length; i++) {
      var href = anchors[i] && anchors[i].getAttribute ? anchors[i].getAttribute("href") : null;
      var p = extractFilesPathFromHref(href);
      if (p && isLikelyVideoPath(p)) return p;
    }

    var dir = getFilesDirPath();
    return joinPaths(dir, nameText);
  }

  function hideFilesGridBuiltInMeta(rowEl, nameEl, detailsBox) {
    if (!rowEl || !rowEl.querySelectorAll) return;

    var nameText = "";
    try {
      nameText = String(nameEl && nameEl.textContent ? nameEl.textContent : "").trim();
    } catch (eName) {
      nameText = "";
    }

    var candidates = rowEl.querySelectorAll("p, span, div, small, time");
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!el || el === nameEl) continue;

      try {
        if (detailsBox && el === detailsBox) continue;
        if (detailsBox && el.closest && el.closest("." + VIDEO_ROW_DETAILS_CLASS)) continue;
      } catch (eClosest) {
        // ignore
      }

      var txt = "";
      try {
        txt = String(el.textContent || "").trim();
      } catch (eTxt) {
        txt = "";
      }
      if (!txt) continue;
      if (txt.length > 80) continue;
      if (nameText && txt.indexOf(nameText) !== -1) continue;

      var lower = txt.toLowerCase();
      var looksLikeAgo = lower.indexOf(" ago") !== -1 || lower.endsWith("ago") || lower.indexOf("yesterday") !== -1;
      var looksLikeSize = /\b\d+(?:\.\d+)?\s*(?:b|kb|mb|gb|tb|kib|mib|gib|tib)\b/.test(lower);
      if (!looksLikeAgo && !looksLikeSize) continue;

      try {
        if (el.style) el.style.display = "none";
      } catch (eHide) {
        // ignore
      }
    }
  }

  function ensureVideoRowDetailsBox(rowEl, nameEl) {
    if (!rowEl || !nameEl) return null;

    var layout = getFilesListingLayout();

    // Grid/mosaic views: keep details *inside* the tile so it's obvious which file they belong to.
    // (A sibling element becomes its own grid cell and looks like it belongs to the item on the left/right.)
    if (layout !== "list") {
      var existingInline = null;
      try {
        existingInline = rowEl.querySelector ? rowEl.querySelector("." + VIDEO_ROW_DETAILS_CLASS) : null;
      } catch (eInline) {
        existingInline = null;
      }
      if (existingInline) {
        try {
          if (nameEl && nameEl.insertAdjacentElement) {
            nameEl.insertAdjacentElement("afterend", existingInline);
          }
        } catch (eMove) {
          // ignore
        }

        hideFilesGridBuiltInMeta(rowEl, nameEl, existingInline);

        return existingInline;
      }

      var inlineBox = document.createElement("div");
      inlineBox.className = VIDEO_ROW_DETAILS_CLASS;
      var inlineLine = document.createElement("span");
      inlineLine.className = "line muted";
      inlineLine.textContent = "Loading video details…";
      inlineBox.appendChild(inlineLine);

      // Allow selecting/copying without opening the file preview.
      inlineBox.addEventListener(
        "click",
        function (e) {
          try { e.preventDefault(); } catch (e1) {}
          try { e.stopPropagation(); } catch (e2) {}
        },
        true
      );
      inlineBox.addEventListener(
        "mousedown",
        function (e) {
          try { e.stopPropagation(); } catch (e3) {}
        },
        true
      );

      var inserted = false;
      try {
        if (nameEl && nameEl.insertAdjacentElement) {
          nameEl.insertAdjacentElement("afterend", inlineBox);
          inserted = true;
        }
      } catch (eInsert) {
        inserted = false;
      }

      if (!inserted) {
        try {
          rowEl.appendChild(inlineBox);
          inserted = true;
        } catch (eApp) {
          inserted = false;
        }
      }

      if (inserted) hideFilesGridBuiltInMeta(rowEl, nameEl, inlineBox);

      return inlineBox;
    }

    // List/table views: prefer a sibling "details row" so we're not constrained by fixed-height/flex overflow in the main row.
    try {
      var next = rowEl.nextElementSibling;
      if (next && next.classList && next.classList.contains(VIDEO_DETAILS_ROW_CLASS)) {
        var existing = next.querySelector("." + VIDEO_ROW_DETAILS_CLASS);
        if (existing) return existing;
      }
    } catch (e0) {
      // ignore
    }

    var detailsRow = null;
    var box = document.createElement("div");
    box.className = VIDEO_ROW_DETAILS_CLASS;
    var line = document.createElement("span");
    line.className = "line muted";
    line.textContent = "Loading video details…";
    box.appendChild(line);

    var tag = String(rowEl.tagName || "").toUpperCase();
    if (tag === "TR") {
      detailsRow = document.createElement("tr");
      detailsRow.className = VIDEO_DETAILS_ROW_CLASS;
      var td = document.createElement("td");
      td.colSpan = 100;
      td.style.padding = "0";
      td.style.border = "0";
      td.appendChild(box);
      detailsRow.appendChild(td);
    } else {
      detailsRow = document.createElement("div");
      detailsRow.className = VIDEO_DETAILS_ROW_CLASS;
      detailsRow.appendChild(box);
    }

    try {
      rowEl.insertAdjacentElement("afterend", detailsRow);
    } catch (e1) {
      try {
        (rowEl.parentNode || document.body).appendChild(detailsRow);
      } catch (e2) {
        return null;
      }
    }

    return box;
  }

  function renderLinesIntoBox(box, lines) {
    if (!box) return;

    while (box.firstChild) box.removeChild(box.firstChild);

    for (var i = 0; i < lines.length; i++) {
      var info = lines[i];
      var row = document.createElement("span");
      row.className = "line" + (info && info.muted ? " muted" : "");
      row.textContent = info && info.text ? info.text : "";
      box.appendChild(row);
    }
  }

  function getVideoMetaLines(data) {
    var out = [];

    if (data && typeof data === "object") {
      var uploadedAt = data.uploaded_at != null ? safeToIso(data.uploaded_at) : "";
      if (uploadedAt) out.push({ text: "Uploaded: " + uploadedAt, muted: true });

      var originalSummary = renderMetaSummary(data.original, data.original_size);
      var processedSummary = renderMetaSummary(data.processed, data.processed_size);

      if (originalSummary && originalSummary !== "—") out.push({ text: "Original: " + originalSummary });
      if (processedSummary && processedSummary !== "—") {
        var action = data.action ? actionLabel(data.action) : "";
        out.push({ text: "After: " + processedSummary + (action ? (" • " + action) : "") });
      }

      if (out.length === 0 && data.status) out.push({ text: "Status: " + String(data.status), muted: true });
    }

    if (out.length === 0) out.push({ text: "No video metadata recorded", muted: true });
    return out;
  }

  function renderCompactVideoMetaLines(data) {
    if (!data || typeof data !== "object") return [];

    var original = data.original && typeof data.original === "object" ? data.original : null;
    var processed = data.processed && typeof data.processed === "object" ? data.processed : null;

    var originalSize = Number(data.original_size);
    var processedSize = Number(data.processed_size);

    var originalSummary = renderMetaSummary(original, originalSize);
    var processedSummary = renderMetaSummary(processed, processedSize);

    var origSizeText = Number.isFinite(originalSize) && originalSize > 0 ? formatBytes(originalSize) : "";
    var procSizeText = Number.isFinite(processedSize) && processedSize > 0 ? formatBytes(processedSize) : "";

    var origVideo = original && original.video && typeof original.video === "object" ? original.video : {};
    var origAudio = original && original.audio && typeof original.audio === "object" ? original.audio : {};
    var procVideo = processed && processed.video && typeof processed.video === "object" ? processed.video : {};
    var procAudio = processed && processed.audio && typeof processed.audio === "object" ? processed.audio : {};

    function codecPair(video, audio) {
      var v = video && video.codec ? String(video.codec).toUpperCase() : "";
      var a = audio && audio.codec ? String(audio.codec).toUpperCase() : "";
      if (v) return a ? (v + "/" + a) : v;
      return a || "";
    }

    var origCodecs = codecPair(origVideo, origAudio);
    var procCodecs = codecPair(procVideo, procAudio);

    function resolution(video) {
      var w = parseInt(String(video && (video.display_width || video.width || "") || ""), 10);
      var h = parseInt(String(video && (video.display_height || video.height || "") || ""), 10);
      return !isNaN(w) && !isNaN(h) && w > 0 && h > 0 ? w + "×" + h : "";
    }

    var res = resolution(procVideo) || resolution(origVideo);
    var dur = Number(processed && processed.duration != null ? processed.duration : (original && original.duration != null ? original.duration : NaN));
    var durText = Number.isFinite(dur) && dur > 0 ? formatDuration(dur) : "";

    var fps = Number(procVideo && procVideo.fps != null ? procVideo.fps : (origVideo && origVideo.fps != null ? origVideo.fps : NaN));
    var fpsText = Number.isFinite(fps) && fps > 0 ? String(Math.round(fps * 100) / 100) + "fps" : "";

    var sizePart = "";
    if (origSizeText && procSizeText) {
      sizePart = origSizeText === procSizeText ? procSizeText : (origSizeText + " → " + procSizeText);
    } else if (procSizeText) sizePart = procSizeText;
    else if (origSizeText) sizePart = origSizeText;

    var codecPart = "";
    if (origCodecs && procCodecs) {
      codecPart = origCodecs === procCodecs ? procCodecs : (origCodecs + " → " + procCodecs);
    } else codecPart = procCodecs || origCodecs;

    var action = data.action ? actionLabel(data.action) : "";

    var lines = [];

    var pctText = "";
    if (
      Number.isFinite(originalSize) &&
      originalSize > 0 &&
      Number.isFinite(processedSize) &&
      processedSize > 0 &&
      originalSize !== processedSize
    ) {
      var pct = Math.round(((processedSize - originalSize) / originalSize) * 100);
      if (pct !== 0) pctText = (pct > 0 ? "+" : "") + String(pct) + "%";
    }

    var primary = "";
    if (sizePart) primary = sizePart;
    if (pctText) primary += (primary ? " " : "") + "(" + pctText + ")";
    if (action) primary += (primary ? " • " : "") + action;
    if (primary) lines.push(primary);

    var secondaryParts = [];
    if (res) secondaryParts.push(res);
    if (codecPart) secondaryParts.push(codecPart);
    if (durText) secondaryParts.push(durText);
    if (fpsText) secondaryParts.push(fpsText);
    if (secondaryParts.length) lines.push(secondaryParts.join(" • "));

    if (lines.length === 0) {
      if (processedSummary && processedSummary !== "—") lines.push("After: " + processedSummary);
      else if (originalSummary && originalSummary !== "—") lines.push("Original: " + originalSummary);
    }

    if (lines.length > 2) lines = lines.slice(0, 2);
    return lines;
  }

  function getVideoMetaLinesCompact(data) {
    var out = [];

    if (data && typeof data === "object") {
      var compactLines = renderCompactVideoMetaLines(data);
      for (var i = 0; i < compactLines.length; i++) {
        if (compactLines[i]) out.push({ text: compactLines[i] });
      }

      if (out.length === 0 && data.status) out.push({ text: "Status: " + String(data.status), muted: true });
    }

    if (out.length === 0) out.push({ text: "No video metadata recorded", muted: true });
    if (out.length > 2) out = out.slice(0, 2);
    return out;
  }

  function getVideoMetaLinesForItem(nameText, data, includeName) {
    var out = [];
    if (includeName) {
      var n = String(nameText || "").trim();
      if (n) out.push({ text: n, muted: true });
    }
    var rest = includeName ? getVideoMetaLines(data) : getVideoMetaLinesCompact(data);
    for (var i = 0; i < rest.length; i++) out.push(rest[i]);
    return out;
  }

  function hydrateFilesVideoRows() {
    if (!isFilesPage()) return;

    ensureVideoMetaStyles();

    var layout = getFilesListingLayout();
    var root = document.getElementById("listing") || document.getElementById("app") || document.body;
    var rows = root && root.querySelectorAll
      ? root.querySelectorAll(".row.list-item, .v-list-item, tr, .item, .file")
      : document.querySelectorAll(".row.list-item, .v-list-item, tr, .item, .file");
    var maxScanRows = 250;
    var maxNewFetches = 8;
    var scanned = 0;
    var started = 0;
    var foundVideos = 0;

    for (var i = 0; i < rows.length && scanned < maxScanRows; i++) {
      var row = rows[i];
      scanned++;
      if (!row || !row.querySelectorAll) continue;
      if (row.classList && row.classList.contains(VIDEO_DETAILS_ROW_CLASS)) continue;

      var nameEl = findVideoNameElementInRow(row);
      if (!nameEl) continue;

      var nameText = String(nameEl.textContent || "").trim();
      if (!isLikelyVideoPath(nameText)) continue;
      foundVideos++;

      var itemEl = row;
      try {
        if (nameEl && nameEl.closest) {
          var closest = nameEl.closest("tr, .row.list-item, .v-list-item, .item, .file");
          if (closest) itemEl = closest;
        }
      } catch (eClosest) {
        itemEl = row;
      }

      var fullPath = extractVideoPathFromRow(itemEl, nameText);
      if (!fullPath || !isLikelyVideoPath(fullPath)) continue;

      var box = ensureVideoRowDetailsBox(itemEl, nameEl);
      if (!box) continue;

      var includeName = layout === "list";
      if (box.dataset && box.dataset.path !== fullPath) {
        box.dataset.path = fullPath;
        box.dataset.name = nameText;
        box.dataset.includeName = includeName ? "1" : "";
        box.dataset.loaded = "";
        var initialLines = includeName
          ? [{ text: nameText, muted: true }, { text: "Loading video details…", muted: true }]
          : [{ text: "Loading video details…", muted: true }];
        renderLinesIntoBox(box, initialLines);
      }

      var hasCache = Object.prototype.hasOwnProperty.call(videoMetaCache, fullPath);
      if (hasCache) {
        var cached = videoMetaCache[fullPath];
        renderLinesIntoBox(box, getVideoMetaLinesForItem(nameText, cached, includeName));
        if (box.dataset) box.dataset.loaded = "1";
        continue;
      }

      if (videoMetaInFlight[fullPath]) {
        continue;
      }

      if (started >= maxNewFetches) continue;

      videoMetaInFlight[fullPath] = true;
      started++;
      (function (path, el) {
        fetchVideoMeta(path)
          .then(function (data) {
            videoMetaCache[path] = (data && typeof data === "object") ? data : null;
            if (el && el.dataset && el.dataset.path === path) {
              renderLinesIntoBox(el, getVideoMetaLinesForItem(el.dataset.name || "", data, el.dataset.includeName === "1"));
              el.dataset.loaded = "1";
            }
          })
          .catch(function () {
            videoMetaCache[path] = null;
            if (el && el.dataset && el.dataset.path === path) {
              renderLinesIntoBox(el, getVideoMetaLinesForItem(el.dataset.name || "", null, el.dataset.includeName === "1"));
              el.dataset.loaded = "1";
            }
          })
          .then(function () {
            delete videoMetaInFlight[path];
            scheduleFilesVideoHydrate();
          });
      })(fullPath, box);
    }

    if (isDropprDebugEnabled()) {
      setDebugBadge(
        "Droppr enhancements v" +
          DROPPR_PANEL_VERSION +
          " • view:" +
          layout +
          " • token:" +
          (getAuthToken() ? "yes" : "no") +
          " • ok:" +
          videoMetaDebugStats.ok +
          " • 404:" +
          videoMetaDebugStats.notFound +
          " • unauth:" +
          videoMetaDebugStats.unauth +
          " • rows:" +
          rows.length +
          " • scanned:" +
          scanned +
          " • videos:" +
          foundVideos +
          " • fetches:" +
          started
      );
    }
  }

  function scheduleFilesVideoHydrate() {
    if (!isFilesPage()) return;

    if (filesVideoHydrateTimer) {
      clearTimeout(filesVideoHydrateTimer);
      filesVideoHydrateTimer = null;
    }

    filesVideoHydrateTimer = setTimeout(function () {
      filesVideoHydrateTimer = null;
      hydrateFilesVideoRows();
    }, 250);
  }

  function shouldShowVideoMetaPanel(path) {
    return !(videoMetaDismissedPath && path === videoMetaDismissedPath);
  }

  function findActiveVideoElement() {
    var sourceEl = document.querySelector('video source[src*=\"/api/raw/\"]');
    if (sourceEl && sourceEl.parentElement && sourceEl.parentElement.tagName === "VIDEO") return sourceEl.parentElement;
    var videoEl = document.querySelector('video[src*=\"/api/raw/\"]');
    return videoEl || null;
  }

  function ensureVideoMetaInlineBox(videoEl) {
    if (!videoEl) return null;
    if (!isFilesPage()) return null;
    ensureVideoMetaStyles();

    try {
      var existing = videoEl.parentNode ? videoEl.parentNode.querySelector("#" + VIDEO_META_INLINE_ID) : null;
      if (existing) return existing;
    } catch (e) {
      // ignore
    }

    var globalExisting = document.getElementById(VIDEO_META_INLINE_ID);
    if (globalExisting && globalExisting.parentNode) {
      try {
        globalExisting.parentNode.removeChild(globalExisting);
      } catch (e2) {
        // ignore
      }
    }

    var box = document.createElement("div");
    box.id = VIDEO_META_INLINE_ID;

    var span = document.createElement("span");
    span.className = "line muted";
    span.textContent = "Loading video details…";
    box.appendChild(span);

    try {
      videoEl.insertAdjacentElement("afterend", box);
    } catch (e3) {
      try {
        (videoEl.parentNode || document.body).appendChild(box);
      } catch (e4) {
        return null;
      }
    }

    return box;
  }

  function updateVideoMetaInline(path, data) {
    if (!isFilesPage()) return;

    var videoEl = findActiveVideoElement();
    if (!videoEl) return;

    var box = ensureVideoMetaInlineBox(videoEl);
    if (!box) return;

    while (box.firstChild) box.removeChild(box.firstChild);

    var lines = [];
    if (data && typeof data === "object") {
      var uploadedAt = data.uploaded_at != null ? safeToIso(data.uploaded_at) : "";
      var status = data.status != null ? String(data.status) : "";

      if (uploadedAt) lines.push("Uploaded: " + uploadedAt);
      else if (status) lines.push("Status: " + status);

      var originalSummary = renderMetaSummary(data.original, data.original_size);
      var processedSummary = renderMetaSummary(data.processed, data.processed_size);

      if (originalSummary && originalSummary !== "—") lines.push("Original: " + originalSummary);
      if (processedSummary && processedSummary !== "—") {
        var action = data.action ? actionLabel(data.action) : "";
        lines.push("After: " + processedSummary + (action ? (" • " + action) : ""));
      }

      if (lines.length === 0 && status) lines.push("Status: " + status);
    }

    if (lines.length === 0) lines.push("Video details unavailable");

    for (var i = 0; i < lines.length; i++) {
      var row = document.createElement("span");
      row.className = "line" + (i === 0 && lines[i].indexOf("Status:") === 0 ? " muted" : "");
      row.textContent = lines[i];
      box.appendChild(row);
    }
  }

  function fetchVideoMeta(path) {
    var token = getAuthToken();

    var opts = { cache: "no-store", credentials: "same-origin" };
    if (token) opts.headers = { "X-Auth": token };

    return fetch("/api/droppr/video-meta?path=" + encodeURIComponent(path), opts)
      .then(function (res) {
        if (isDropprDebugEnabled() && res) {
          if (res.status === 200) videoMetaDebugStats.ok++;
          else if (res.status === 404) videoMetaDebugStats.notFound++;
          else if (res.status === 401 || res.status === 403) videoMetaDebugStats.unauth++;
          else videoMetaDebugStats.other++;
        }
        if (!res || !res.ok) return null;
        return res.json().catch(function () {
          return null;
        });
      })
      .catch(function () {
        return null;
      });
  }

  function updateVideoMetaPanel(path, data) {
    var panel = ensureVideoMetaPanel();
    if (!panel) return;

    var name = String(path || "").split("/").pop() || String(path || "");
    var status = (data && data.status) ? String(data.status) : "—";
    var action = data && data.action ? actionLabel(data.action) : "—";

    var uploadedAt = data && data.uploaded_at != null ? safeToIso(data.uploaded_at) : "";
    var processedAt = data && data.processed_at != null ? safeToIso(data.processed_at) : "";
    var originalSummary = data ? renderMetaSummary(data.original, data.original_size) : "—";
    var processedSummary = data ? renderMetaSummary(data.processed, data.processed_size) : "—";

    panel.querySelector("#droppr-video-meta-path").textContent = name + "  •  " + path;
    panel.querySelector("#droppr-video-meta-status").textContent = status;
    panel.querySelector("#droppr-video-meta-uploaded").textContent = uploadedAt || "—";
    panel.querySelector("#droppr-video-meta-processed-at").textContent = processedAt || "—";
    panel.querySelector("#droppr-video-meta-original").textContent = originalSummary;
    panel.querySelector("#droppr-video-meta-processed").textContent = processedSummary;
    panel.querySelector("#droppr-video-meta-action").textContent = action;

    panel.style.display = "block";
  }

  function showVideoMetaForPath(path) {
    if (!path || !isLikelyVideoPath(path)) return;

    videoMetaActivePath = path;
    var cached = videoMetaCache[path];
    if (cached) {
      if (shouldShowVideoMetaPanel(path)) updateVideoMetaPanel(path, cached);
      updateVideoMetaInline(path, cached);
      return;
    }

    var loading = { status: "loading", action: "", uploaded_at: null, original: null, processed: null };
    if (shouldShowVideoMetaPanel(path)) updateVideoMetaPanel(path, loading);
    updateVideoMetaInline(path, loading);
    fetchVideoMeta(path).then(function (data) {
      if (!data || typeof data !== "object") return;
      videoMetaCache[path] = data;
      if (videoMetaActivePath === path) {
        if (shouldShowVideoMetaPanel(path)) updateVideoMetaPanel(path, data);
        updateVideoMetaInline(path, data);
      }
    });
  }

  function findActiveVideoRawSrc() {
    var sourceEl = document.querySelector('video source[src*=\"/api/raw/\"]');
    if (sourceEl && sourceEl.getAttribute) return sourceEl.getAttribute("src");
    var videoEl = document.querySelector('video[src*=\"/api/raw/\"]');
    if (videoEl && videoEl.getAttribute) return videoEl.getAttribute("src");
    return null;
  }

  function startVideoMetaWatcher() {
    if (videoMetaPollTimer) return;

    var lastSeenPath = null;
    videoMetaPollTimer = setInterval(function () {
      var src = findActiveVideoRawSrc();
      if (!src) {
        lastSeenPath = null;
        return;
      }

      var rawPath = extractApiPath(src, "/api/raw");
      if (rawPath == null) return;

      var normalized = normalizePathEncoded(rawPath);
      var decoded = normalized;
      try {
        decoded = decodeURIComponent(normalized);
      } catch (e) {
        decoded = normalized;
      }

      decoded = normalizePathEncoded(decoded);
      if (!isLikelyVideoPath(decoded)) return;

      if (lastSeenPath !== decoded) {
        videoMetaDismissedPath = null;
        lastSeenPath = decoded;
      }

      if (decoded !== videoMetaActivePath) {
        showVideoMetaForPath(decoded);
        return;
      }

      var cached = videoMetaCache[decoded];
      if (cached) {
        updateVideoMetaInline(decoded, cached);
        if (shouldShowVideoMetaPanel(decoded)) updateVideoMetaPanel(decoded, cached);
      } else {
        showVideoMetaForPath(decoded);
      }

      // Keep /files list decorations up to date (SPA navigations + virtualized rows).
      if (isFilesPage()) {
        if (filesVideoLastPathname !== String(window.location && window.location.pathname)) {
          filesVideoLastPathname = String(window.location && window.location.pathname);
          scheduleFilesVideoHydrate();
        }
      }
    }, 1000);
  }

  function ensureShareExpireStyles() {
    if (document.getElementById(SHARE_EXPIRE_STYLE_ID)) return;

    var style = document.createElement("style");
    style.id = SHARE_EXPIRE_STYLE_ID;
    style.textContent =
      "." + SHARE_EXPIRE_BTN_CLASS + " { margin-left: 6px; }\n" +
      "." + SHARE_EXPIRE_BTN_CLASS + "[disabled] { opacity: 0.55; cursor: not-allowed; }\n";
    document.head.appendChild(style);
  }

  function ensureDropprSettingsStyles() {
    if (document.getElementById(DROPPR_SETTINGS_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = DROPPR_SETTINGS_STYLE_ID;
    style.textContent =
      "#" + DROPPR_SETTINGS_CARD_ID + " {\n" +
      "  margin: 12px 0 16px;\n" +
      "  padding: 14px;\n" +
      "  border-radius: 14px;\n" +
      "  border: 1px solid rgba(255,255,255,0.12);\n" +
      "  background: rgba(30,41,59,0.55);\n" +
      "  box-shadow: 0 16px 38px -28px rgba(0,0,0,0.55);\n" +
      "  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;\n" +
      "  color: rgba(241,245,249,0.98);\n" +
      "}\n" +
      ":root.dark #" + DROPPR_SETTINGS_CARD_ID + " {\n" +
      "  border-color: rgba(255,255,255,0.12);\n" +
      "}\n" +
      ":root:not(.dark) #" + DROPPR_SETTINGS_CARD_ID + " {\n" +
      "  background: rgba(255,255,255,0.9);\n" +
      "  border-color: rgba(0,0,0,0.12);\n" +
      "  color: rgba(15,23,42,0.98);\n" +
      "}\n" +
      "#" + DROPPR_SETTINGS_CARD_ID + " .hdr {\n" +
      "  display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;\n" +
      "}\n" +
      "#" + DROPPR_SETTINGS_CARD_ID + " .title {\n" +
      "  font-weight: 900;\n" +
      "  letter-spacing: -0.01em;\n" +
      "  font-size: 14px;\n" +
      "}\n" +
      "#" + DROPPR_SETTINGS_CARD_ID + " .sub {\n" +
      "  margin-top: 6px;\n" +
      "  font-size: 12px;\n" +
      "  opacity: 0.8;\n" +
      "  line-height: 1.35;\n" +
      "}\n" +
      "#" + DROPPR_SETTINGS_CARD_ID + " .grid {\n" +
      "  margin-top: 12px;\n" +
      "  display: grid;\n" +
      "  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));\n" +
      "  gap: 10px;\n" +
      "}\n" +
      "#" + DROPPR_SETTINGS_CARD_ID + " label {\n" +
      "  display:block;\n" +
      "  font-size: 11px;\n" +
      "  font-weight: 900;\n" +
      "  letter-spacing: 0.03em;\n" +
      "  text-transform: uppercase;\n" +
      "  opacity: 0.8;\n" +
      "  margin-bottom: 6px;\n" +
      "}\n" +
      "#" + DROPPR_SETTINGS_CARD_ID + " input {\n" +
      "  width: 100%;\n" +
      "  border-radius: 12px;\n" +
      "  padding: 10px 12px;\n" +
      "  font-size: 13px;\n" +
      "  border: 1px solid rgba(255,255,255,0.14);\n" +
      "  background: rgba(2,6,23,0.22);\n" +
      "  color: inherit;\n" +
      "  outline: none;\n" +
      "}\n" +
      ":root:not(.dark) #" + DROPPR_SETTINGS_CARD_ID + " input {\n" +
      "  border-color: rgba(0,0,0,0.12);\n" +
      "  background: rgba(2,6,23,0.04);\n" +
      "}\n" +
      "#" + DROPPR_SETTINGS_CARD_ID + " .actions {\n" +
      "  margin-top: 12px;\n" +
      "  display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;\n" +
      "}\n" +
      "#" + DROPPR_SETTINGS_CARD_ID + " .btn {\n" +
      "  appearance:none;\n" +
      "  border: 1px solid rgba(255,255,255,0.14);\n" +
      "  background: rgba(255,255,255,0.08);\n" +
      "  color: inherit;\n" +
      "  padding: 9px 11px;\n" +
      "  border-radius: 999px;\n" +
      "  cursor: pointer;\n" +
      "  font-weight: 900;\n" +
      "  font-size: 12px;\n" +
      "}\n" +
      ":root:not(.dark) #" + DROPPR_SETTINGS_CARD_ID + " .btn {\n" +
      "  border-color: rgba(0,0,0,0.12);\n" +
      "  background: rgba(2,6,23,0.04);\n" +
      "}\n" +
      "#" + DROPPR_SETTINGS_CARD_ID + " .btn.primary {\n" +
      "  background: rgba(99, 102, 241, 0.92);\n" +
      "  border-color: rgba(255,255,255,0.14);\n" +
      "  color: #070b16;\n" +
      "}\n" +
      "#" + DROPPR_SETTINGS_CARD_ID + " .msg {\n" +
      "  margin-top: 10px;\n" +
      "  font-size: 12px;\n" +
      "  line-height: 1.35;\n" +
      "  opacity: 0.92;\n" +
      "}\n";
    document.head.appendChild(style);
  }

  function ensureDropprSessionSettingsCard() {
    var existing = document.getElementById(DROPPR_SETTINGS_CARD_ID);
    if (!isLoggedIn() || !isSettingsPage() || isSharesPage()) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }

    var token = getAuthToken();
    var storedIsAdmin = null;
    try {
      storedIsAdmin = localStorage.getItem(SESSION_IS_ADMIN_KEY);
    } catch (e) {
      storedIsAdmin = null;
    }

    if (storedIsAdmin === "0") {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }

    if (storedIsAdmin !== "1") {
      var now = nowMs();
      if (token && !sessionSettingsAdminCheckInFlight && now - sessionSettingsAdminCheckedAt > 30000) {
        sessionSettingsAdminCheckInFlight = true;
        sessionSettingsAdminCheckedAt = now;
        detectIsAdmin(token)
          .then(function (v) {
            try {
              localStorage.setItem(SESSION_IS_ADMIN_KEY, v ? "1" : "0");
            } catch (e2) {}
          })
          .catch(function () {})
          .finally(function () {
            sessionSettingsAdminCheckInFlight = false;
            ensureDropprSessionSettingsCard();
          });
      }

      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }

    if (existing) return;

    ensureDropprSettingsStyles();

    var host = null;
    try {
      host =
        document.querySelector(".v-main__wrap") ||
        document.querySelector("main") ||
        document.querySelector("#app") ||
        null;

      if (host && host.querySelector) {
        host =
          host.querySelector(".container") ||
          host.querySelector(".v-content__wrap") ||
          host;
      }
    } catch (e) {
      host = null;
    }

    if (!host || !host.insertBefore) return;

    var card = document.createElement("div");
    card.id = DROPPR_SETTINGS_CARD_ID;

    card.innerHTML =
      '<div class="hdr">' +
      '  <div style="min-width:0">' +
      '    <div class="title">Droppr Session Settings</div>' +
      '    <div class="sub">Controls automatic logout in the browser (client-side). Set 0 to disable a timer.</div>' +
      "  </div>" +
      "</div>" +
      '<div class="grid">' +
      '  <div><label>Admin idle (minutes)</label><input id="droppr-sess-admin-idle" type="number" min="0" step="1" /></div>' +
      '  <div><label>Admin max (minutes)</label><input id="droppr-sess-admin-max" type="number" min="0" step="1" /></div>' +
      '  <div><label>User idle (minutes)</label><input id="droppr-sess-user-idle" type="number" min="0" step="1" /></div>' +
      '  <div><label>User max (minutes)</label><input id="droppr-sess-user-max" type="number" min="0" step="1" /></div>' +
      '  <div><label>Warning (seconds)</label><input id="droppr-sess-warn-sec" type="number" min="0" step="1" /></div>' +
      "</div>" +
      '<div class="actions">' +
      '  <button class="btn primary" type="button" id="droppr-sess-save">Save</button>' +
      '  <button class="btn" type="button" id="droppr-sess-reset">Reset defaults</button>' +
      "</div>" +
      '<div class="msg" id="droppr-sess-msg"></div>';

    host.insertBefore(card, host.firstChild || null);

    function getEl(id) {
      try {
        return document.getElementById(id);
      } catch (e) {
        return null;
      }
    }

    var msgEl = getEl("droppr-sess-msg");
    function setMsg(text, isError) {
      if (!msgEl) return;
      msgEl.textContent = text || "";
      msgEl.style.color = isError ? "rgba(239,68,68,0.95)" : "";
      msgEl.style.display = text ? "block" : "none";
    }

    function readInt(id) {
      var el = getEl(id);
      var v = el ? parseIntOrNull(el.value) : null;
      if (v == null || v < 0) v = 0;
      return v;
    }

    function api(path, options) {
      if (!token) return Promise.reject(new Error("Not logged in"));
      var opts = options || {};
      var headers = opts.headers || {};
      headers["X-Auth"] = token;
      opts.headers = headers;
      return fetch(path, opts).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try {
            data = JSON.parse(text || "{}");
          } catch (e) {
            data = null;
          }
          if (!res.ok) {
            var msg = (data && data.error) ? String(data.error) : (text || ("HTTP " + res.status));
            throw new Error(msg);
          }
          return data || {};
        });
      });
    }

    function fillFrom(data) {
      var s = data && data.session ? data.session : null;
      if (!s) return;
      var aIdle = getEl("droppr-sess-admin-idle");
      var aMax = getEl("droppr-sess-admin-max");
      var uIdle = getEl("droppr-sess-user-idle");
      var uMax = getEl("droppr-sess-user-max");
      var warn = getEl("droppr-sess-warn-sec");
      if (aIdle) aIdle.value = String(Number(s.admin_idle_minutes || 0));
      if (aMax) aMax.value = String(Number(s.admin_max_minutes || 0));
      if (uIdle) uIdle.value = String(Number(s.user_idle_minutes || 0));
      if (uMax) uMax.value = String(Number(s.user_max_minutes || 0));
      if (warn) warn.value = String(Number(s.warning_seconds || 0));
    }

    function load() {
      setMsg("Loading…", false);
      return api("/api/droppr/session-settings", { method: "GET" })
        .then(function (data) {
          fillFrom(data);
          setMsg("Loaded. Save to apply.", false);
          setTimeout(function () { setMsg("", false); }, 1200);
        })
        .catch(function (err) {
          setMsg(String(err && err.message ? err.message : err), true);
        });
    }

    function save() {
      var btn = getEl("droppr-sess-save");
      if (btn) btn.disabled = true;
      setMsg("Saving…", false);
      return api("/api/droppr/session-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          admin_idle_minutes: readInt("droppr-sess-admin-idle"),
          admin_max_minutes: readInt("droppr-sess-admin-max"),
          user_idle_minutes: readInt("droppr-sess-user-idle"),
          user_max_minutes: readInt("droppr-sess-user-max"),
          warning_seconds: readInt("droppr-sess-warn-sec"),
        }),
      })
        .then(function (data) {
          fillFrom(data);
          setMsg("Saved.", false);
          setTimeout(function () { setMsg("", false); }, 1200);
        })
        .catch(function (err) {
          setMsg(String(err && err.message ? err.message : err), true);
        })
        .then(function () {
          if (btn) btn.disabled = false;
        });
    }

    function reset() {
      var btn = getEl("droppr-sess-reset");
      if (btn) btn.disabled = true;
      setMsg("", false);
      var ok = false;
      try {
        ok = !!window.confirm("Reset session settings to defaults?");
      } catch (e) {
        ok = false;
      }
      if (!ok) {
        if (btn) btn.disabled = false;
        return;
      }

      setMsg("Resetting…", false);
      return api("/api/droppr/session-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reset: true }),
      })
        .then(function (data) {
          fillFrom(data);
          setMsg("Reset to defaults.", false);
          setTimeout(function () { setMsg("", false); }, 1200);
        })
        .catch(function (err) {
          setMsg(String(err && err.message ? err.message : err), true);
        })
        .then(function () {
          if (btn) btn.disabled = false;
        });
    }

    var saveBtn = getEl("droppr-sess-save");
    if (saveBtn) saveBtn.addEventListener("click", function () { save(); });
    var resetBtn = getEl("droppr-sess-reset");
    if (resetBtn) resetBtn.addEventListener("click", function () { reset(); });

    load();
  }

  function isSharesPage() {
    var p = String((window.location && window.location.pathname) || "");
    return p.indexOf("/settings/shares") !== -1;
  }

  function isSettingsPage() {
    var p = String((window.location && window.location.pathname) || "");
    return p === "/settings" || p.indexOf("/settings/") === 0;
  }

  function extractShareHashFromHref(href) {
    var s = String(href || "");
    var m = s.match(/\/share\/([^/?#]+)/);
    if (m && m[1]) return m[1];
    m = s.match(/share\/([^/?#]+)/);
    if (m && m[1]) return m[1];
    return null;
  }

  function getDefaultShareExpireHours() {
    var stored = null;
    try {
      stored = localStorage.getItem(SHARE_EXPIRE_STORAGE_KEY);
    } catch (e) {
      stored = null;
    }
    var n = parseIntOrNull(stored);
    if (n == null || n < 0) return 30;
    return n;
  }

  function updateShareExpire(shareHash, hours, sharePath) {
    var token = getAuthToken();
    if (!token) return Promise.reject(new Error("Not logged in"));

    return fetch("/api/droppr/shares/" + encodeURIComponent(shareHash) + "/expire", {
      method: "POST",
      headers: {
        "X-Auth": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hours: hours, path: sharePath || "" }),
    }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) {
          throw new Error("Update failed (" + res.status + "): " + (text || ""));
        }
        if (!text) return {};
        try {
          return JSON.parse(text);
        } catch (e) {
          return {};
        }
      });
    });
  }

  function fmtRelativeExpire(unixSeconds) {
    if (unixSeconds == null) return "";
    var ts = parseInt(String(unixSeconds), 10);
    if (isNaN(ts)) return "";
    if (ts === 0) return "permanent";

    var deltaSec = Math.floor((ts * 1000 - nowMs()) / 1000);
    if (deltaSec <= 0) return "expired";

    var days = Math.floor(deltaSec / 86400);
    if (days >= 2) return "in " + days + " days";
    if (days === 1) return "in 1 day";

    var hours = Math.floor(deltaSec / 3600);
    if (hours >= 2) return "in " + hours + " hours";
    if (hours === 1) return "in 1 hour";

    var minutes = Math.floor(deltaSec / 60);
    if (minutes >= 2) return "in " + minutes + " minutes";
    if (minutes === 1) return "in 1 minute";

    return "in " + deltaSec + " seconds";
  }

  function fetchShareAliases(limit) {
    var token = getAuthToken();
    if (!token) return Promise.reject(new Error("Not logged in"));

    var q = typeof limit === "number" ? ("?limit=" + String(limit)) : "";
    return fetch("/api/droppr/shares/aliases" + q, {
      method: "GET",
      headers: { "X-Auth": token },
    }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) throw new Error("Aliases failed (" + res.status + "): " + (text || ""));
        if (!text) return { aliases: [] };
        try {
          return JSON.parse(text);
        } catch (e) {
          return { aliases: [] };
        }
      });
    });
  }

  function applyAliasToShareRow(rowEl, alias) {
    if (!rowEl || !alias) return;

    var tds = rowEl.querySelectorAll ? rowEl.querySelectorAll("td") : null;
    if (!tds || tds.length < 2) return;

    var expireText = fmtRelativeExpire(alias.target_expire);
    var base = expireText ? ("Aliased (" + expireText + ")") : "Aliased";
    tds[1].textContent = base;
  }

  var _shareAliasesState = { loading: false, lastAppliedAt: 0, cache: null };

  function ensureShareAliasesApplied() {
    if (!isLoggedIn()) return;
    if (!isSharesPage()) return;

    var t = nowMs();
    if (_shareAliasesState.lastAppliedAt && t - _shareAliasesState.lastAppliedAt < 2500) return;
    if (_shareAliasesState.loading) return;

    _shareAliasesState.loading = true;
    fetchShareAliases(2000)
      .then(function (payload) {
        _shareAliasesState.cache = payload && payload.aliases ? payload.aliases : [];
      })
      .catch(function () {
        _shareAliasesState.cache = [];
      })
      .then(function () {
        _shareAliasesState.loading = false;
        _shareAliasesState.lastAppliedAt = nowMs();

        var aliases = _shareAliasesState.cache || [];
        if (!aliases || aliases.length === 0) return;

        var targets = {};
        var byFrom = {};
        for (var i = 0; i < aliases.length; i++) {
          var a = aliases[i];
          if (!a) continue;
          if (a.to_hash) targets[String(a.to_hash)] = true;
          if (a.from_hash) byFrom[String(a.from_hash)] = a;
        }

        var rows = document.querySelectorAll("tr");
        for (var r = 0; r < rows.length; r++) {
          var row = rows[r];
          if (!row || !row.querySelector) continue;
          var anchor = row.querySelector('a[href*="/share/"]') || row.querySelector('a[href*="share/"]');
          if (!anchor) continue;
          var hash = extractShareHashFromHref(anchor.getAttribute("href"));
          if (!hash) continue;

          if (targets[hash]) {
            row.style.display = "none";
            continue;
          }

          if (byFrom[hash]) {
            applyAliasToShareRow(row, byFrom[hash]);
          }
        }
      });
  }

  function ensureShareExpireButtons() {
    if (!isLoggedIn()) return;
    if (!isSharesPage()) return;

    ensureShareExpireStyles();
    ensureShareAliasesApplied();

    var copyButtons = document.querySelectorAll("button.copy-clipboard");
    for (var i = 0; i < copyButtons.length; i++) {
      var copyBtn = copyButtons[i];
      if (!copyBtn || !copyBtn.parentNode) continue;

      var host = copyBtn.parentNode;
      if (host.querySelector && host.querySelector("." + SHARE_EXPIRE_BTN_CLASS)) continue;

      var row = null;
      try {
        row = copyBtn.closest ? copyBtn.closest("tr") : null;
      } catch (e) {
        row = null;
      }
      if (!row || !row.querySelector) continue;

      var shareAnchor = row.querySelector('a[href*="/share/"]') || row.querySelector('a[href*="share/"]');
      if (!shareAnchor) continue;

      var shareHash = extractShareHashFromHref(shareAnchor.getAttribute("href"));
      if (!shareHash) continue;

      var sharePath = String(shareAnchor.textContent || "").trim();

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "action " + SHARE_EXPIRE_BTN_CLASS;
      btn.setAttribute("aria-label", "Change share expiration");
      btn.title = "Change share expiration";
      btn.innerHTML = '<i class="material-icons">schedule</i>';

      (function (hash, pathLabel, buttonEl, rowEl) {
        buttonEl.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();

          var defaultHours = getDefaultShareExpireHours();
          var promptText =
            "Set share duration in hours from now (0 = permanent)\n\n" +
            (pathLabel ? ("Path: " + pathLabel + "\n") : "") +
            "Share: " + hash;
          var raw = null;
          try {
            raw = window.prompt(promptText, String(defaultHours));
          } catch (e2) {
            raw = null;
          }
          if (raw == null) return;

          var rawTrim = String(raw).trim();
          if (rawTrim === "") rawTrim = "0";
          if (!/^[0-9]+$/.test(rawTrim)) {
            showAutoShareModal({
              title: "Invalid duration",
              subtitle: pathLabel || "",
              url: "",
              note: "Enter a whole number of hours (0 = permanent).",
              autoCopy: false,
            });
            return;
          }

          var hours = parseInt(rawTrim, 10);
          if (isNaN(hours) || hours < 0) {
            showAutoShareModal({
              title: "Invalid duration",
              subtitle: pathLabel || "",
              url: "",
              note: "Hours must be 0 or greater.",
              autoCopy: false,
            });
            return;
          }

          try {
            localStorage.setItem(SHARE_EXPIRE_STORAGE_KEY, String(hours));
          } catch (e3) {
            // ignore
          }

          buttonEl.disabled = true;
          updateShareExpire(hash, hours, pathLabel)
            .then(function (data) {
              var h = data && data.hash ? data.hash : hash;
              var shareUrl = window.location.origin + "/api/public/dl/" + h;
              var note = hours === 0 ? "Share is now permanent." : ("Share now expires in " + hours + " hours.");
              note += " (Link stays the same.)";

              if (rowEl && data) {
                applyAliasToShareRow(rowEl, data);
              }

              showAutoShareModal({
                title: "Share time updated",
                subtitle: pathLabel || "",
                url: shareUrl,
                openUrl: window.location.origin + "/gallery/" + h,
                note: note,
                autoCopy: false,
              });
            })
            .catch(function (err) {
              showAutoShareModal({
                title: "Could not update share time",
                subtitle: pathLabel || "",
                url: "",
                note: String(err && err.message ? err.message : err),
                autoCopy: false,
              });
            })
            .then(function () {
              buttonEl.disabled = false;
            });
        });
      })(shareHash, sharePath, btn, row);

      host.appendChild(btn);
    }
  }

  function ensureShareDialogStreamButtons() {
    if (!isLoggedIn()) return;

    var dialogs = document.querySelectorAll
      ? document.querySelectorAll(".v-dialog__content--active, .v-dialog--active, [role=\"dialog\"]")
      : [];
    if (!dialogs || dialogs.length === 0) return;

    ensureStreamShareStyles();

    for (var d = 0; d < dialogs.length; d++) {
      var dialog = dialogs[d];
      if (!dialog || !dialog.querySelectorAll) continue;

      // Skip our own toast/modal UI
      if (dialog.id === AUTO_SHARE_MODAL_ID) continue;

      var copyButtons = dialog.querySelectorAll("button.copy-clipboard");
      for (var i = 0; i < copyButtons.length; i++) {
        var copyBtn = copyButtons[i];
        if (!copyBtn || !copyBtn.parentNode) continue;

        var host = copyBtn.parentNode;
        if (host.querySelector && host.querySelector("." + STREAM_SHARE_BTN_CLASS)) continue;

        var shareHash = findShareHashNearEl(copyBtn);
        if (!shareHash) continue;

        var streamBtn = copyBtn.cloneNode(true);
        if (streamBtn.classList && streamBtn.classList.remove) streamBtn.classList.remove("copy-clipboard");
        streamBtn.className = String(streamBtn.className || "").replace(/\bcopy-clipboard\b/g, "").trim();
        streamBtn.className = (streamBtn.className ? (streamBtn.className + " ") : "") + STREAM_SHARE_BTN_CLASS;
        streamBtn.type = "button";
        streamBtn.title = "Stream Gallery link";
        streamBtn.setAttribute("aria-label", "Stream Gallery link");
        setMaterialIconText(streamBtn, "smart_display");

        (function (hash, btnEl) {
          btnEl.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();

            var streamUrl = buildStreamUrl(hash);
            var shareUrl = buildShareUrl(hash);

            showAutoShareModal({
              title: "Stream Gallery link",
              subtitle: "",
              urlLabel: "Stream Gallery (best for big videos):",
              url: streamUrl,
              openUrl: streamUrl,
              streamLabel: "Standard share link (gallery):",
              streamUrl: shareUrl,
              note: "Tip: If iOS video scrubbing is slow, use the Stream link.",
              autoCopy: true,
              autoCopyValue: streamUrl,
            });
          });
        })(shareHash, streamBtn);

        host.insertBefore(streamBtn, copyBtn.nextSibling);
      }
    }
  }

  function ensureFilesStreamShareButton() {
    if (!isLoggedIn()) return;
    if (!isFilesPage()) return;

    ensureStreamShareStyles();

    function isInDialogOrMenu(el) {
      try {
        return !!(
          el &&
          el.closest &&
          (el.closest(".v-dialog__content--active") ||
            el.closest(".v-dialog--active") ||
            el.closest(".v-menu__content") ||
            el.closest("[role=\"dialog\"]"))
        );
      } catch (e) {
        return false;
      }
    }

    function isVisible(el) {
      if (!el) return false;
      try {
        if (el.offsetParent) return true;
        var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        return !!(rect && rect.width > 0 && rect.height > 0);
      } catch (e) {
        return true;
      }
    }

    function attachToShareButton(shareBtn) {
      if (!shareBtn) return false;
      if (shareBtn.classList && shareBtn.classList.contains(FILES_STREAM_SHARE_BTN_CLASS)) return false;
      if (isInDialogOrMenu(shareBtn)) return false;
      if (!isVisible(shareBtn)) return false;

      var host = shareBtn.parentNode;
      if (!host || !host.insertBefore) return false;

      var disabled =
        !!shareBtn.disabled ||
        shareBtn.getAttribute("disabled") != null ||
        shareBtn.getAttribute("aria-disabled") === "true" ||
        (shareBtn.classList && shareBtn.classList.contains("v-btn--disabled"));

      var existing = host.querySelector ? host.querySelector("." + FILES_STREAM_SHARE_BTN_CLASS) : null;
      if (existing) {
        existing.disabled = disabled;
        try {
          if (existing.classList) {
            if (disabled) existing.classList.add("v-btn--disabled");
            else existing.classList.remove("v-btn--disabled");
          }
        } catch (e3) {
          // ignore
        }

        try {
          existing.style.display = shareBtn.style && shareBtn.style.display === "none" ? "none" : "";
        } catch (e4) {
          // ignore
        }
        return true;
      }

      var newBtn = shareBtn.cloneNode(true);
      if (newBtn.classList && newBtn.classList.add) newBtn.classList.add(FILES_STREAM_SHARE_BTN_CLASS);
      newBtn.title = "Stream Share";
      newBtn.setAttribute("aria-label", "Stream Share");
      setMaterialIconText(newBtn, "smart_display");
      newBtn.disabled = disabled;

      newBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();

        var rowEl = getSelectedFilesRowEl();
        var decodedPath = extractSelectedPathFromFilesRow(rowEl);
        if (!decodedPath) {
          showAutoShareModal({
            title: "Select a file or folder",
            subtitle: "",
            url: "",
            note: "Select a file/folder in the list first, then click Stream Share again.",
            autoCopy: false,
          });
          return;
        }

        var apiPath = encodePathSegmentsForApi(decodedPath);
        var label = String(decodedPath).split("/").pop() || decodedPath;

        newBtn.disabled = true;
        createShare(apiPath)
          .then(function (resp) {
            var hash = resp && resp.hash ? resp.hash : "";
            if (!hash) throw new Error("Share response missing hash");

            var streamUrl = buildStreamUrl(hash);
            var shareUrl = buildShareUrl(hash);

            showAutoShareModal({
              title: "Stream link ready",
              subtitle: label ? ("Selected: " + label) : "",
              urlLabel: "Stream Gallery (best for big videos):",
              url: streamUrl,
              openUrl: streamUrl,
              streamLabel: "Standard share link (gallery):",
              streamUrl: shareUrl,
              note: "Recipients can view without logging in.",
              autoCopy: true,
              autoCopyValue: streamUrl,
            });
          })
          .catch(function (err) {
            showAutoShareModal({
              title: "Could not create share link",
              subtitle: label ? ("Selected: " + label) : "",
              url: "",
              note: String(err && err.message ? err.message : err),
              autoCopy: false,
            });
          })
          .then(function () {
            newBtn.disabled = false;
          });
      });

      host.insertBefore(newBtn, shareBtn.nextSibling);
      return true;
    }

    var iconNodes = document.querySelectorAll
      ? document.querySelectorAll("i.material-icons, span.material-icons, .material-icons")
      : [];
    for (var i = 0; i < iconNodes.length; i++) {
      var icon = iconNodes[i];
      if (!icon) continue;
      var txt = String(icon.textContent || "").trim();
      if (txt !== "share") continue;

      var shareBtn = null;
      try {
        shareBtn = icon.closest ? icon.closest("button, a") : null;
      } catch (e) {
        shareBtn = null;
      }
      if (attachToShareButton(shareBtn)) return;
    }

    // Fallback: find a Share button by title/aria-label/text (in case the icon isn't "share").
    var btnCandidates = document.querySelectorAll ? document.querySelectorAll("button, a") : [];
    for (var b = 0; b < btnCandidates.length; b++) {
      var el = btnCandidates[b];
      if (!el) continue;
      if (el.classList && el.classList.contains(FILES_STREAM_SHARE_BTN_CLASS)) continue;
      if (isInDialogOrMenu(el)) continue;
      if (!isVisible(el)) continue;

      var label = (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) || "";
      var labelLower = String(label || "").toLowerCase();
      var textLower = String(el.textContent || "").trim().toLowerCase();

      if (labelLower.indexOf("share") === -1 && textLower !== "share") continue;

      if (attachToShareButton(el)) return;
    }
  }

  function ensureQuickShareStyles() {
    if (document.getElementById(QUICK_SHARE_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = QUICK_SHARE_STYLE_ID;
    style.textContent =
      "." + QUICK_SHARE_BTN_CLASS + " { margin-left: 6px; }\n" +
      "." + QUICK_SHARE_BTN_CLASS + "[disabled] { opacity: 0.55; cursor: not-allowed; }\n";
    document.head.appendChild(style);
  }

  function ensureFilesQuickShareButton() {
    if (!isLoggedIn()) return;
    if (!isFilesPage()) return;

    ensureQuickShareStyles();

    function isInDialogOrMenu(el) {
      try {
        return !!(
          el &&
          el.closest &&
          (el.closest(".v-dialog__content--active") ||
            el.closest(".v-dialog--active") ||
            el.closest(".v-menu__content") ||
            el.closest("[role=\"dialog\"]"))
        );
      } catch (e) {
        return false;
      }
    }

    function isVisible(el) {
      if (!el) return false;
      try {
        if (el.offsetParent) return true;
        var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        return !!(rect && rect.width > 0 && rect.height > 0);
      } catch (e) {
        return true;
      }
    }

    function attachToShareButton(shareBtn) {
      if (!shareBtn) return false;
      if (shareBtn.classList && shareBtn.classList.contains(QUICK_SHARE_BTN_CLASS)) return false;
      if (isInDialogOrMenu(shareBtn)) return false;
      if (!isVisible(shareBtn)) return false;

      var host = shareBtn.parentNode;
      if (!host || !host.insertBefore) return false;

      var disabled =
        !!shareBtn.disabled ||
        shareBtn.getAttribute("disabled") != null ||
        shareBtn.getAttribute("aria-disabled") === "true" ||
        (shareBtn.classList && shareBtn.classList.contains("v-btn--disabled"));

      var existing = host.querySelector ? host.querySelector("." + QUICK_SHARE_BTN_CLASS) : null;
      if (existing) {
        existing.disabled = disabled;
        try {
          if (existing.classList) {
            if (disabled) existing.classList.add("v-btn--disabled");
            else existing.classList.remove("v-btn--disabled");
          }
        } catch (e3) {
          // ignore
        }

        try {
          existing.style.display = shareBtn.style && shareBtn.style.display === "none" ? "none" : "";
        } catch (e4) {
          // ignore
        }
        return true;
      }

      var newBtn = shareBtn.cloneNode(true);
      if (newBtn.classList && newBtn.classList.add) newBtn.classList.add(QUICK_SHARE_BTN_CLASS);
      newBtn.title = "Quick Share (Direct Link)";
      newBtn.setAttribute("aria-label", "Quick Share (Direct Link)");
      setMaterialIconText(newBtn, "link");
      newBtn.disabled = disabled;

      newBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();

        var rowEl = getSelectedFilesRowEl();
        var decodedPath = extractSelectedPathFromFilesRow(rowEl);
        if (!decodedPath) {
          showAutoShareModal({
            title: "Select a file or folder",
            subtitle: "",
            url: "",
            note: "Select a file/folder in the list first, then click Quick Share again.",
            autoCopy: false,
          });
          return;
        }

        var apiPath = encodePathSegmentsForApi(decodedPath);
        var label = String(decodedPath).split("/").pop() || decodedPath;
        var isFolder = !label.includes(".") || label.endsWith("/");

        newBtn.disabled = true;
        createShare(apiPath)
          .then(function (resp) {
            var hash = resp && resp.hash ? resp.hash : "";
            if (!hash) throw new Error("Share response missing hash");

            var directUrl = window.location.origin + "/api/public/dl/" + hash;
            var zipUrl = window.location.origin + "/api/share/" + hash + "/download";

            if (isFolder) {
              showAutoShareModal({
                title: "Direct share link ready",
                subtitle: label ? ("Folder: " + label) : "",
                urlLabel: "Direct link (opens folder view):",
                url: directUrl,
                openUrl: directUrl,
                streamLabel: "Download as ZIP:",
                streamUrl: zipUrl,
                note: "Recipients can access without logging in.",
                autoCopy: true,
                autoCopyValue: directUrl,
              });
            } else {
              showAutoShareModal({
                title: "Direct download link ready",
                subtitle: label ? ("File: " + label) : "",
                urlLabel: "Direct download link:",
                url: directUrl,
                openUrl: directUrl,
                note: "Recipients can download without logging in.",
                autoCopy: true,
                autoCopyValue: directUrl,
              });
            }
          })
          .catch(function (err) {
            showAutoShareModal({
              title: "Could not create share link",
              subtitle: label ? ("Selected: " + label) : "",
              url: "",
              note: String(err && err.message ? err.message : err),
              autoCopy: false,
            });
          })
          .then(function () {
            newBtn.disabled = false;
          });
      });

      host.insertBefore(newBtn, shareBtn.nextSibling);
      return true;
    }

    var iconNodes = document.querySelectorAll
      ? document.querySelectorAll("i.material-icons, span.material-icons, .material-icons")
      : [];
    for (var i = 0; i < iconNodes.length; i++) {
      var icon = iconNodes[i];
      if (!icon) continue;
      var txt = String(icon.textContent || "").trim();
      if (txt !== "share") continue;

      var shareBtn = null;
      try {
        shareBtn = icon.closest ? icon.closest("button, a") : null;
      } catch (e) {
        shareBtn = null;
      }
      if (attachToShareButton(shareBtn)) return;
    }

    var candidates = document.querySelectorAll
      ? document.querySelectorAll("button, a[href]")
      : [];
    for (var j = 0; j < candidates.length; j++) {
      var el = candidates[j];
      if (!el) continue;
      if (isInDialogOrMenu(el)) continue;
      if (!isVisible(el)) continue;

      var label = (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) || "";
      var labelLower = String(label || "").toLowerCase();
      var textLower = String(el.textContent || "").trim().toLowerCase();

      if (labelLower.indexOf("share") === -1 && textLower !== "share") continue;

      if (attachToShareButton(el)) return;
    }
  }

  function ensureAutoShareStyles() {
    if (document.getElementById(AUTO_SHARE_STYLE_ID)) return;

    var style = document.createElement("style");
    style.id = AUTO_SHARE_STYLE_ID;
    style.textContent =
      "#" + AUTO_SHARE_MODAL_ID + " {\n" +
      "  position: fixed;\n" +
      "  right: 18px;\n" +
      "  bottom: 74px;\n" +
      "  z-index: 2147483001;\n" +
      "  width: 460px;\n" +
      "  max-width: calc(100vw - 36px);\n" +
      "  border-radius: 14px;\n" +
      "  background: var(--droppr-overlay-bg, rgba(17, 24, 39, 0.98));\n" +
      "  color: var(--text-primary, #e5e7eb);\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.12));\n" +
      "  box-shadow: 0 26px 60px -30px rgba(0,0,0,0.85);\n" +
      "  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;\n" +
      "  overflow: hidden;\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .hdr {\n" +
      "  display: flex;\n" +
      "  align-items: flex-start;\n" +
      "  justify-content: space-between;\n" +
      "  gap: 12px;\n" +
      "  padding: 14px 14px 8px 14px;\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .title {\n" +
      "  font-size: 14px;\n" +
      "  font-weight: 800;\n" +
      "  line-height: 1.2;\n" +
      "  color: var(--text-primary, #fff);\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .subtitle {\n" +
      "  font-size: 12px;\n" +
      "  line-height: 1.2;\n" +
      "  margin-top: 4px;\n" +
      "  color: var(--droppr-overlay-muted, rgba(229,231,235,0.8));\n" +
      "  word-break: break-word;\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .close {\n" +
      "  appearance: none;\n" +
      "  border: 0;\n" +
      "  background: transparent;\n" +
      "  color: var(--droppr-overlay-muted, rgba(229,231,235,0.85));\n" +
      "  cursor: pointer;\n" +
      "  font-size: 18px;\n" +
      "  line-height: 1;\n" +
      "  padding: 6px 8px;\n" +
      "  border-radius: 10px;\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .close:hover {\n" +
      "  background: var(--hover-bg, rgba(255,255,255,0.08));\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .body {\n" +
      "  padding: 0 14px 14px 14px;\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .row {\n" +
      "  display: flex;\n" +
      "  gap: 10px;\n" +
      "  align-items: center;\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " input {\n" +
      "  flex: 1 1 auto;\n" +
      "  width: 100%;\n" +
      "  border-radius: 10px;\n" +
      "  border: 1px solid var(--border-color, rgba(255,255,255,0.12));\n" +
      "  background: var(--input-bg, rgba(0,0,0,0.22));\n" +
      "  padding: 10px 10px;\n" +
      "  color: var(--text-primary, #fff);\n" +
      "  font-size: 13px;\n" +
      "  outline: none;\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " input:focus {\n" +
      "  border-color: rgba(99,102,241,0.7);\n" +
      "  box-shadow: 0 0 0 3px rgba(99,102,241,0.18);\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .btn {\n" +
      "  flex: 0 0 auto;\n" +
      "  cursor: pointer;\n" +
      "  border: 1px solid var(--border-color, rgba(255,255,255,0.12));\n" +
      "  background: var(--accent-color, rgba(99, 102, 241, 0.95));\n" +
      "  color: #fff;\n" +
      "  font-weight: 800;\n" +
      "  font-size: 13px;\n" +
      "  padding: 10px 12px;\n" +
      "  border-radius: 10px;\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .btn.secondary {\n" +
      "  background: var(--hover-bg, rgba(255,255,255,0.08));\n" +
      "  color: var(--text-primary, #fff);\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .btn:hover {\n" +
      "  filter: brightness(1.05);\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .note {\n" +
      "  margin-top: 10px;\n" +
      "  font-size: 12px;\n" +
      "  color: var(--text-secondary, rgba(229,231,235,0.72));\n" +
      "}\n";

    document.head.appendChild(style);
  }

  function dismissAutoShareModal() {
    var el = document.getElementById(AUTO_SHARE_MODAL_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // Robust clipboard copy with iOS Safari fallback
  function copyText(text) {
    // Try modern Clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        // If Clipboard API fails, try fallback
        return copyTextFallback(text);
      });
    }
    return copyTextFallback(text);
  }

  function copyTextFallback(text) {
    return new Promise(function (resolve, reject) {
      try {
        var textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        // Position on-screen but visually hidden (iOS Safari needs this)
        textarea.style.cssText = "position:fixed;top:0;left:0;width:2em;height:2em;padding:0;border:none;outline:none;box-shadow:none;background:transparent;font-size:16px;";
        document.body.appendChild(textarea);

        // iOS Safari specific handling
        var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        if (isIOS) {
          var range = document.createRange();
          range.selectNodeContents(textarea);
          var selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          textarea.setSelectionRange(0, text.length);
        } else {
          textarea.focus();
          textarea.select();
        }

        var ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (!ok) return reject(new Error("Copy failed"));
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  function extractShareHashFromText(text) {
    var s = String(text || "");

    var m = s.match(/\/api\/public\/dl\/([A-Za-z0-9_-]{1,64})/);
    if (m && m[1]) return m[1];

    m = s.match(/\/(?:share|gallery|stream)\/([A-Za-z0-9_-]{1,64})/);
    if (m && m[1]) return m[1];

    m = s.match(/(?:^|[?&])share=([A-Za-z0-9_-]{1,64})(?:&|$)/);
    if (m && m[1]) return m[1];

    if (/^[A-Za-z0-9_-]{1,64}$/.test(s)) return s;
    return null;
  }

  function buildShareUrl(shareHash) {
    return window.location.origin + "/api/public/dl/" + shareHash;
  }

  function buildGalleryUrl(shareHash) {
    return window.location.origin + "/gallery/" + shareHash;
  }

  function buildStreamUrl(shareHash) {
    return window.location.origin + "/stream/" + shareHash;
  }

  function findShareHashNearEl(el) {
    if (!el) return null;

    var attrs = ["data-clipboard-text", "data-clipboardText", "data-copy", "data-text"];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute ? el.getAttribute(attrs[i]) : null;
      var h = extractShareHashFromText(v);
      if (h) return h;
    }

    // Scan up a few levels and look for share links/inputs.
    var cur = el;
    for (var depth = 0; depth < 5 && cur; depth++) {
      if (cur.querySelectorAll) {
        var inputs = cur.querySelectorAll("input");
        for (var ii = 0; ii < inputs.length; ii++) {
          var iv = inputs[ii] && inputs[ii].value;
          var ih = extractShareHashFromText(iv);
          if (ih) return ih;
        }

        var anchors = cur.querySelectorAll("a[href]");
        for (var ai = 0; ai < anchors.length; ai++) {
          var href = anchors[ai] && anchors[ai].getAttribute ? anchors[ai].getAttribute("href") : null;
          var ah = extractShareHashFromText(href);
          if (ah) return ah;
        }
      }

      cur = cur.parentNode;
    }

    return null;
  }

  function setMaterialIconText(btn, iconText) {
    if (!btn) return;
    var icon = btn.querySelector
      ? (btn.querySelector("i.material-icons") || btn.querySelector(".material-icons") || btn.querySelector("i"))
      : null;
    if (!icon) return;
    icon.textContent = iconText;
  }

  function ensureStreamShareStyles() {
    if (document.getElementById(STREAM_SHARE_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STREAM_SHARE_STYLE_ID;
    style.textContent =
      "." + STREAM_SHARE_BTN_CLASS + " { margin-left: 6px; }\n" +
      "." + STREAM_SHARE_BTN_CLASS + "[disabled] { opacity: 0.55; cursor: not-allowed; }\n" +
      "." + FILES_STREAM_SHARE_BTN_CLASS + " { margin-left: 6px; }\n" +
      "." + FILES_STREAM_SHARE_BTN_CLASS + "[disabled] { opacity: 0.55; cursor: not-allowed; }\n";
    document.head.appendChild(style);
  }

  function showAutoShareModal(opts) {
    ensureAutoShareStyles();
    dismissAutoShareModal();
    opts = opts || {};

    var modal = document.createElement("div");
    modal.id = AUTO_SHARE_MODAL_ID;

    var header = document.createElement("div");
    header.className = "hdr";

    var headerText = document.createElement("div");
    var title = document.createElement("div");
    title.className = "title";
    title.textContent = opts.title || "Share link ready";

    var subtitle = document.createElement("div");
    subtitle.className = "subtitle";
    subtitle.textContent = opts.subtitle || "";

    headerText.appendChild(title);
    if (opts.subtitle) headerText.appendChild(subtitle);

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", dismissAutoShareModal);

    header.appendChild(headerText);
    header.appendChild(closeBtn);

    var body = document.createElement("div");
    body.className = "body";

    if (opts.urlLabel) {
      var urlLabel = document.createElement("div");
      urlLabel.style.fontSize = "0.8rem";
      urlLabel.style.color = "var(--text-muted, #888)";
      urlLabel.style.marginBottom = "0.35rem";
      urlLabel.textContent = String(opts.urlLabel || "");
      body.appendChild(urlLabel);
    }

    var primaryUrl = String(opts.url || "").trim();
    var openTarget = String(opts.openUrl || "").trim() || primaryUrl;
    var hasPrimaryUrl = primaryUrl.length > 0;
    var input = null;
    var copyBtn = null;

    if (hasPrimaryUrl) {
      var row = document.createElement("div");
      row.className = "row";

      input = document.createElement("input");
      input.type = "text";
      input.readOnly = true;
      input.value = primaryUrl;
      input.addEventListener("focus", function () {
        try {
          input.select();
        } catch (e) {
          // ignore
        }
      });

      copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", function () {
        copyBtn.textContent = "Copy";
        copyText(input.value)
          .then(function () {
            copyBtn.textContent = "Copied";
            setTimeout(function () {
              if (document.body.contains(copyBtn)) copyBtn.textContent = "Copy";
            }, 1200);
          })
          .catch(function () {
            copyBtn.textContent = "Copy";
            try {
              input.focus();
              input.select();
            } catch (e) {
              // ignore
            }
          });
      });

      var openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "btn secondary";
      openBtn.textContent = "Open";
      openBtn.addEventListener("click", function () {
        if (!openTarget) return;
        try {
          window.open(openTarget, "_blank", "noopener");
        } catch (e) {
          window.location.href = openTarget;
        }
      });

      row.appendChild(input);
      row.appendChild(copyBtn);
      row.appendChild(openBtn);
      body.appendChild(row);
    }

    // Stream Gallery row (for video-optimized player)
    if (opts.streamUrl) {
      var streamRow = document.createElement("div");
      streamRow.className = "row";
      streamRow.style.marginTop = "0.75rem";

      var streamLabel = document.createElement("div");
      streamLabel.style.fontSize = "0.8rem";
      streamLabel.style.color = "var(--text-muted, #888)";
      streamLabel.style.marginBottom = "0.35rem";
      streamLabel.textContent = opts.streamLabel || "Stream Gallery (optimized for large videos):";
      
      var streamInput = document.createElement("input");
      streamInput.type = "text";
      streamInput.readOnly = true;
      streamInput.value = opts.streamUrl;
      streamInput.addEventListener("focus", function () {
        try { streamInput.select(); } catch (e) {}
      });

      var streamCopyBtn = document.createElement("button");
      streamCopyBtn.type = "button";
      streamCopyBtn.className = "btn";
      streamCopyBtn.textContent = "Copy";
      streamCopyBtn.addEventListener("click", function () {
        copyText(streamInput.value)
          .then(function () {
            streamCopyBtn.textContent = "Copied";
            setTimeout(function () {
              if (document.body.contains(streamCopyBtn)) streamCopyBtn.textContent = "Copy";
            }, 1200);
          })
          .catch(function () {
            try { streamInput.focus(); streamInput.select(); } catch (e) {}
          });
      });

      var streamOpenBtn = document.createElement("button");
      streamOpenBtn.type = "button";
      streamOpenBtn.className = "btn secondary";
      streamOpenBtn.textContent = "Open";
      streamOpenBtn.addEventListener("click", function () {
        try { window.open(opts.streamUrl, "_blank", "noopener"); }
        catch (e) { window.location.href = opts.streamUrl; }
      });

      body.appendChild(streamLabel);
      streamRow.appendChild(streamInput);
      streamRow.appendChild(streamCopyBtn);
      streamRow.appendChild(streamOpenBtn);
      body.appendChild(streamRow);
    }

    var note = document.createElement("div");
    note.className = "note";
    note.textContent = opts.note || "";
    if (opts.note) body.appendChild(note);

    modal.appendChild(header);
    modal.appendChild(body);
    document.body.appendChild(modal);

    if (input) {
      try {
        input.focus();
        input.select();
      } catch (e) {
        // ignore
      }
    }

    if (opts.autoCopy && hasPrimaryUrl && copyBtn) {
      var valueToCopy = opts.autoCopyValue || primaryUrl;
      copyText(valueToCopy)
        .then(function () {
          copyBtn.textContent = "Copied";
          setTimeout(function () {
            if (document.body.contains(copyBtn)) copyBtn.textContent = "Copy";
          }, 1200);
        })
        .catch(function () {
          // ignore
        });
    }
  }

  function normalizeUrl(input) {
    try {
      return new URL(input, window.location.href);
    } catch (e) {
      return null;
    }
  }

  function extractApiPath(urlLike, prefix) {
    var u = normalizeUrl(urlLike);
    if (!u) return null;
    if (u.pathname === prefix) return "";
    if (u.pathname.indexOf(prefix + "/") !== 0) return null;
    return u.pathname.substring(prefix.length);
  }

  function extractResourcePath(urlLike) {
    return extractApiPath(urlLike, "/api/resources");
  }

  function extractTusPath(urlLike) {
    return extractApiPath(urlLike, "/api/tus");
  }

  function hasBinaryBody(body) {
    if (!body) return false;
    if (typeof FormData !== "undefined" && body instanceof FormData) return true;
    if (typeof Blob !== "undefined" && body instanceof Blob) return true;
    if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) return true;
    if (typeof Uint8Array !== "undefined" && body instanceof Uint8Array) return true;
    return false;
  }

  function parseIntOrNull(value) {
    if (value == null) return null;
    var n = parseInt(String(value), 10);
    return isNaN(n) ? null : n;
  }

  function normalizePathEncoded(pathEncoded) {
    var p = String(pathEncoded || "");
    if (p === "") return "/";
    if (p.charAt(0) !== "/") p = "/" + p;
    if (p.length > 1 && p.charAt(p.length - 1) === "/") p = p.slice(0, -1);
    return p;
  }

  function getHeaderValue(headers, name) {
    if (!headers || !name) return null;
    var key = String(name).toLowerCase();

    if (typeof Headers !== "undefined" && headers instanceof Headers) {
      return headers.get(name) || headers.get(key);
    }

    if (Array.isArray(headers)) {
      for (var i = 0; i < headers.length; i++) {
        var pair = headers[i];
        if (!pair || pair.length < 2) continue;
        if (String(pair[0]).toLowerCase() === key) return String(pair[1]);
      }
      return null;
    }

    if (typeof headers === "object") {
      if (Object.prototype.hasOwnProperty.call(headers, name)) return headers[name];
      for (var k in headers) {
        if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
        if (String(k).toLowerCase() === key) return headers[k];
      }
    }

    return null;
  }

  function getBodyFileNames(body) {
    var names = [];
    var seen = {};

    function add(name) {
      if (!name) return;
      if (seen[name]) return;
      seen[name] = true;
      names.push(name);
    }

    if (!body) return names;

    if (typeof FormData !== "undefined" && body instanceof FormData) {
      try {
        var it = body.entries();
        var e = it.next();
        while (!e.done) {
          var v = e.value && e.value[1];
          if (v && typeof v === "object" && typeof v.name === "string") add(v.name);
          e = it.next();
        }
      } catch (e2) {
        // ignore
      }

      return names;
    }

    if (body && typeof body === "object" && typeof body.name === "string") add(body.name);
    return names;
  }

  function sanitizeFileName(name) {
    var s = String(name || "");
    s = s.split("/").pop() || s;
    s = s.split("\\").pop() || s;
    return s;
  }

  function pathEndsWithFileName(pathEncoded, fileName) {
    if (!pathEncoded || !fileName) return false;
    var last = String(pathEncoded).split("/").pop() || "";
    try {
      if (decodeURIComponent(last) === fileName) return true;
    } catch (e) {
      // ignore
    }
    return last === encodeURIComponent(fileName);
  }

  function joinDirAndFileEncoded(dirEncoded, fileName) {
    var dir = normalizePathEncoded(dirEncoded);
    var base = sanitizeFileName(fileName);
    var encodedName = encodeURIComponent(base);
    if (dir === "/") return "/" + encodedName;
    return dir + "/" + encodedName;
  }

  function getResourceUploadPaths(urlLike, method, body) {
    if (!urlLike) return [];
    if (!method) return [];
    var m = String(method).toUpperCase();
    if (m !== "POST" && m !== "PUT") return [];

    var rawPath = extractResourcePath(urlLike);
    if (rawPath == null) return [];
    if (!hasBinaryBody(body)) return [];

    var fileNames = getBodyFileNames(body);
    var normalizedBase = normalizePathEncoded(rawPath);

    if (!fileNames.length) {
      if (normalizedBase === "/") return [];
      return [normalizedBase];
    }

    if (fileNames.length === 1 && rawPath && rawPath !== "/" && pathEndsWithFileName(rawPath, fileNames[0])) {
      return [normalizePathEncoded(rawPath)];
    }

    var out = [];
    for (var i = 0; i < fileNames.length; i++) {
      out.push(joinDirAndFileEncoded(normalizedBase, fileNames[i]));
    }
    return out;
  }

  function getTusUploadPath(urlLike) {
    var rawPath = extractTusPath(urlLike);
    if (rawPath == null) return null;
    var p = normalizePathEncoded(rawPath);
    if (!p || p === "/") return null;
    return p;
  }

  function ensureTusEntry(pathEncoded) {
    if (!pathEncoded) return null;
    var p = normalizePathEncoded(pathEncoded);
    if (!p || p === "/") return null;

    var existing = tusUploads[p];
    if (existing && existing.item && !existing.item.done) return existing;

    var item = recordUploadStart(p);
    var entry = { path: p, item: item, uploadLength: null, lastSeenAt: 0, timer: null };
    tusUploads[p] = entry;
    return entry;
  }

  function finishTusEntry(entry, ok) {
    if (!entry || !entry.item || entry.item.done) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    delete tusUploads[entry.path];
    recordUploadDone(entry.item, ok);
  }

  function scheduleTusIdleComplete(entry) {
    if (!entry || !entry.item || entry.item.done) return;
    var idleMs = 1800;
    entry.lastSeenAt = nowMs();

    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(function () {
      if (!entry || !entry.item || entry.item.done) return;
      var age = nowMs() - entry.lastSeenAt;
      if (age < idleMs) {
        scheduleTusIdleComplete(entry);
        return;
      }
      finishTusEntry(entry, true);
    }, idleMs);
  }

  function handleTusPatchProgress(entry, offsetValue, lengthValue) {
    if (!entry || !entry.item || entry.item.done) return;

    var offset = parseIntOrNull(offsetValue);
    var length = parseIntOrNull(lengthValue);

    if (length != null) entry.uploadLength = length;
    if (length == null && entry.uploadLength != null) length = entry.uploadLength;

    if (offset != null && length != null && length >= 0 && offset >= length) {
      finishTusEntry(entry, true);
      return;
    }

    scheduleTusIdleComplete(entry);
  }

  function startUploadBatch() {
    if (!uploadBatch) {
      uploadBatch = { pending: 0, items: [], timer: null };
      return;
    }

    if (uploadBatch.timer) {
      clearTimeout(uploadBatch.timer);
      uploadBatch.timer = null;
    }
  }

  function recordUploadStart(pathEncoded) {
    startUploadBatch();
    var item = { path: pathEncoded, ok: false, done: false };
    uploadBatch.pending += 1;
    uploadBatch.items.push(item);
    return item;
  }

  function finalizeUploadBatch(batch) {
    if (!batch || uploadBatch !== batch) return;
    uploadBatch = null;

    var attempted = {};
    var succeeded = {};

    for (var i = 0; i < batch.items.length; i++) {
      var p = batch.items[i] && batch.items[i].path;
      if (!p) continue;
      attempted[p] = true;
      if (batch.items[i].ok) succeeded[p] = true;
    }

    var attemptedKeys = Object.keys(attempted);
    var succeededKeys = Object.keys(succeeded);
    if (attemptedKeys.length !== 1 || succeededKeys.length !== 1) return;

    var pathEncoded = succeededKeys[0];
    var t = nowMs();
    if (lastAutoSharedPath === pathEncoded && t - lastAutoSharedAt < 5000) return;
    lastAutoSharedPath = pathEncoded;
    lastAutoSharedAt = t;

    createShare(pathEncoded)
      .then(function (resp) {
        var shareUrl = window.location.origin + "/api/public/dl/" + resp.hash;
        var fileLabel = decodeURIComponent(String(pathEncoded).split("/").pop() || "");
        showAutoShareModal({
          title: "Share link ready",
          subtitle: fileLabel ? ("Uploaded: " + fileLabel) : "",
          url: shareUrl,
          openUrl: window.location.origin + "/gallery/" + resp.hash,
          streamUrl: window.location.origin + "/stream/" + resp.hash,
          note: "Recipients can view without logging in.",
          autoCopy: true,
        });
      })
      .catch(function (err) {
        showAutoShareModal({
          title: "Upload complete",
          subtitle: "Could not create share link",
          url: "",
          note: String(err && err.message ? err.message : err),
          autoCopy: false,
        });
      });
  }

  function recordUploadDone(item, ok) {
    if (!uploadBatch) return;
    item.done = true;
    item.ok = !!ok;
    uploadBatch.pending = Math.max(0, uploadBatch.pending - 1);

    if (uploadBatch.pending !== 0) return;
    var batch = uploadBatch;
    uploadBatch.timer = setTimeout(function () {
      finalizeUploadBatch(batch);
    }, 700);
  }

  function createShare(pathEncoded) {
    var token = getAuthToken();
    if (!token) return Promise.reject(new Error("Not logged in"));

    function encodePathSegments(decodedPath) {
      var s = String(decodedPath || "");
      if (s && s.charAt(0) !== "/") s = "/" + s;
      s = s.replace(/^\/+/, "/");
      var parts = s.split("/");
      for (var i = 0; i < parts.length; i++) {
        if (parts[i] === "") continue;
        parts[i] = encodeURIComponent(parts[i]);
      }
      return parts.join("/");
    }

    function doShareFetch(encodedPath) {
      return fetch("/api/share" + encodedPath, {
        method: "POST",
        headers: {
          "X-Auth": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expires: "", password: "" }),
      }).then(function (res) {
        return res.text().then(function (text) {
          if (!res.ok) {
            throw new Error("Share API failed (" + res.status + "): " + (text || ""));
          }
          var data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            throw new Error("Unexpected share response");
          }
          if (!data || !data.hash) throw new Error("Share response missing hash");
          return data;
        });
      });
    }

    return doShareFetch(pathEncoded).catch(function (err) {
      if (String(pathEncoded || "").indexOf("%2F") === -1) throw err;

      var decoded;
      try {
        decoded = decodeURIComponent(String(pathEncoded));
      } catch (e) {
        throw err;
      }

      var normalized = encodePathSegments(decoded);
      if (!normalized || normalized === pathEncoded) throw err;
      return doShareFetch(normalized);
    });
  }

  function patchUploadDetectors() {
    if (window.__dropprUploadDetectorsPatched) return;
    window.__dropprUploadDetectorsPatched = true;

    if (window.fetch) {
      var origFetch = window.fetch;
      window.fetch = function (input, init) {
        var urlLike = null;
        var method = "GET";
        var body = null;
        var headers = null;

        if (typeof input === "string") {
          urlLike = input;
        } else if (input && typeof input === "object") {
          urlLike = input.url;
          method = input.method || method;
          headers = input.headers || headers;
        }

        if (init && init.method) method = init.method;
        if (init && Object.prototype.hasOwnProperty.call(init, "body")) body = init.body;
        if (init && init.headers) headers = init.headers;

        var mUpper = String(method || "GET").toUpperCase();
        var tusEntry = null;
        var tusPath = getTusUploadPath(urlLike);
        if (tusPath && (mUpper === "POST" || mUpper === "PATCH")) {
          tusEntry = ensureTusEntry(tusPath);
          if (tusEntry && mUpper === "POST" && tusEntry.uploadLength == null) {
            tusEntry.uploadLength = parseIntOrNull(getHeaderValue(headers, "Upload-Length"));
          }
        }

        var resourceRecords = [];
        var resourcePaths = getResourceUploadPaths(urlLike, method, body);
        for (var i = 0; i < resourcePaths.length; i++) {
          resourceRecords.push(recordUploadStart(resourcePaths[i]));
        }

        var p = origFetch.apply(this, arguments);
        if (!tusEntry && resourceRecords.length === 0) return p;

        return p.then(
          function (resp) {
            if (tusEntry) {
              if (!resp || !resp.ok) {
                finishTusEntry(tusEntry, false);
                return resp;
              }

              if (mUpper === "POST") {
                if (tusEntry.uploadLength === 0) finishTusEntry(tusEntry, true);
                return resp;
              }

              if (mUpper === "PATCH") {
                handleTusPatchProgress(
                  tusEntry,
                  resp.headers ? resp.headers.get("Upload-Offset") : null,
                  resp.headers ? resp.headers.get("Upload-Length") : null
                );
              }

              return resp;
            }

            for (var i = 0; i < resourceRecords.length; i++) {
              recordUploadDone(resourceRecords[i], resp && resp.ok);
            }
            return resp;
          },
          function (err) {
            if (tusEntry) {
              finishTusEntry(tusEntry, false);
            } else {
              for (var i = 0; i < resourceRecords.length; i++) {
                recordUploadDone(resourceRecords[i], false);
              }
            }
            throw err;
          }
        );
      };
    }

    if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
      var origOpen = window.XMLHttpRequest.prototype.open;
      var origSend = window.XMLHttpRequest.prototype.send;
      var origSetRequestHeader = window.XMLHttpRequest.prototype.setRequestHeader;

      window.XMLHttpRequest.prototype.open = function (method, url) {
        this.__dropprMethod = method;
        this.__dropprUrl = url;
        this.__dropprHeaders = {};
        return origOpen.apply(this, arguments);
      };

      window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try {
          if (this.__dropprHeaders && name) {
            this.__dropprHeaders[String(name).toLowerCase()] = value;
          }
        } catch (e) {
          // ignore
        }
        return origSetRequestHeader.apply(this, arguments);
      };

      window.XMLHttpRequest.prototype.send = function (body) {
        var method = this.__dropprMethod || "GET";
        var urlLike = this.__dropprUrl || "";
        var mUpper = String(method || "GET").toUpperCase();

        var tusEntry = null;
        var tusPath = getTusUploadPath(urlLike);
        if (tusPath && (mUpper === "POST" || mUpper === "PATCH")) {
          tusEntry = ensureTusEntry(tusPath);
          if (tusEntry && mUpper === "POST" && tusEntry.uploadLength == null) {
            tusEntry.uploadLength = parseIntOrNull(this.__dropprHeaders && this.__dropprHeaders["upload-length"]);
          }
        }

        var resourceRecords = [];
        var resourcePaths = getResourceUploadPaths(urlLike, method, body);
        for (var i = 0; i < resourcePaths.length; i++) {
          resourceRecords.push(recordUploadStart(resourcePaths[i]));
        }

        if (tusEntry || resourceRecords.length) {
          var xhr = this;
          var onDone = function () {
            xhr.removeEventListener("loadend", onDone);
            var ok = xhr.status >= 200 && xhr.status < 300;

            if (tusEntry) {
              if (!ok) {
                finishTusEntry(tusEntry, false);
                return;
              }

              if (mUpper === "POST") {
                if (tusEntry.uploadLength === 0) finishTusEntry(tusEntry, true);
                return;
              }

              if (mUpper === "PATCH") {
                var off = null;
                var len = null;
                try {
                  off = xhr.getResponseHeader("Upload-Offset");
                  len = xhr.getResponseHeader("Upload-Length");
                } catch (e) {
                  // ignore
                }
                handleTusPatchProgress(tusEntry, off, len);
              }

              return;
            }

            for (var i = 0; i < resourceRecords.length; i++) {
              recordUploadDone(resourceRecords[i], ok);
            }
          };
          xhr.addEventListener("loadend", onDone);
        }

        return origSend.apply(this, arguments);
      };
    }
  }

  function isIOSDevice() {
    try {
      if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
      // iPadOS 13+ reports as "Macintosh" but still has touch points.
      if (navigator.platform === "MacIntel" && navigator.maxTouchPoints && navigator.maxTouchPoints > 1) return true;
    } catch (e) {
      // ignore
    }
    return false;
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function ensureIcloudWaitStyles() {
    if (document.getElementById(ICLOUD_WAIT_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = ICLOUD_WAIT_STYLE_ID;
    style.textContent =
      "#" + ICLOUD_WAIT_MODAL_ID + " {\n" +
      "  position: fixed;\n" +
      "  top: 18px;\n" +
      "  left: 50%;\n" +
      "  transform: translateX(-50%);\n" +
      "  z-index: 2147483002;\n" +
      "  width: 560px;\n" +
      "  max-width: calc(100vw - 36px);\n" +
      "  border-radius: 14px;\n" +
      "  background: var(--droppr-overlay-bg, rgba(17, 24, 39, 0.98));\n" +
      "  color: var(--text-primary, #e5e7eb);\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.12));\n" +
      "  box-shadow: 0 26px 60px -30px rgba(0,0,0,0.85);\n" +
      "  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;\n" +
      "  overflow: hidden;\n" +
      "}\n" +
      "#" + ICLOUD_WAIT_MODAL_ID + " .row {\n" +
      "  display: flex;\n" +
      "  align-items: center;\n" +
      "  gap: 10px;\n" +
      "  padding: 14px;\n" +
      "}\n" +
      "#" + ICLOUD_WAIT_MODAL_ID + " .spinner {\n" +
      "  width: 18px;\n" +
      "  height: 18px;\n" +
      "  border-radius: 999px;\n" +
      "  border: 2px solid var(--border-color, rgba(255,255,255,0.25));\n" +
      "  border-top-color: rgba(99, 102, 241, 0.95);\n" +
      "  animation: droppr-spin 1s linear infinite;\n" +
      "  flex: 0 0 auto;\n" +
      "}\n" +
      "#" + ICLOUD_WAIT_MODAL_ID + " .txt {\n" +
      "  flex: 1 1 auto;\n" +
      "  min-width: 0;\n" +
      "}\n" +
      "#" + ICLOUD_WAIT_MODAL_ID + " .title {\n" +
      "  font-size: 13px;\n" +
      "  font-weight: 800;\n" +
      "  color: var(--text-primary, #fff);\n" +
      "  line-height: 1.15;\n" +
      "}\n" +
      "#" + ICLOUD_WAIT_MODAL_ID + " .status {\n" +
      "  margin-top: 4px;\n" +
      "  font-size: 12px;\n" +
      "  color: var(--droppr-overlay-muted, rgba(229,231,235,0.82));\n" +
      "  word-break: break-word;\n" +
      "  line-height: 1.2;\n" +
      "}\n" +
      "#" + ICLOUD_WAIT_MODAL_ID + " .note {\n" +
      "  margin-top: 6px;\n" +
      "  font-size: 12px;\n" +
      "  color: var(--text-secondary, rgba(229,231,235,0.65));\n" +
      "}\n" +
      "#" + ICLOUD_WAIT_MODAL_ID + " .btn {\n" +
      "  flex: 0 0 auto;\n" +
      "  cursor: pointer;\n" +
      "  border: 1px solid var(--border-color, rgba(255,255,255,0.12));\n" +
      "  background: var(--hover-bg, rgba(255,255,255,0.08));\n" +
      "  color: var(--text-primary, #fff);\n" +
      "  font-weight: 700;\n" +
      "  font-size: 12px;\n" +
      "  padding: 9px 11px;\n" +
      "  border-radius: 10px;\n" +
      "}\n" +
      "#" + ICLOUD_WAIT_MODAL_ID + " .btn:hover {\n" +
      "  filter: brightness(1.05);\n" +
      "}\n" +
      "@keyframes droppr-spin { to { transform: rotate(360deg); } }\n";
    document.head.appendChild(style);
  }

  function showIcloudWaitModal() {
    ensureIcloudWaitStyles();
    var existing = document.getElementById(ICLOUD_WAIT_MODAL_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var modal = document.createElement("div");
    modal.id = ICLOUD_WAIT_MODAL_ID;

    var row = document.createElement("div");
    row.className = "row";

    var spinner = document.createElement("div");
    spinner.className = "spinner";

    var txt = document.createElement("div");
    txt.className = "txt";

    var title = document.createElement("div");
    title.className = "title";
    title.textContent = "Waiting for iCloud download…";

    var status = document.createElement("div");
    status.className = "status";
    status.textContent = "Preparing upload…";

    var note = document.createElement("div");
    note.className = "note";
    note.textContent = "Keep this tab open. Upload starts automatically once the file is ready.";

    txt.appendChild(title);
    txt.appendChild(status);
    txt.appendChild(note);

    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "Cancel";

    row.appendChild(spinner);
    row.appendChild(txt);
    row.appendChild(cancel);

    modal.appendChild(row);
    document.body.appendChild(modal);

    return {
      setStatus: function (text) {
        status.textContent = text || "Preparing upload…";
      },
      onCancel: function (fn) {
        cancel.addEventListener("click", fn);
      },
      dismiss: function () {
        if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
      },
    };
  }

  function readBlobAsArrayBuffer(blob, timeoutMs) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      var timeout = null;

      function cleanup() {
        if (timeout) clearTimeout(timeout);
        reader.onload = null;
        reader.onerror = null;
      }

      reader.onload = function () {
        var bytes = 0;
        try {
          bytes = reader.result && reader.result.byteLength ? reader.result.byteLength : 0;
        } catch (e) {
          bytes = 0;
        }
        cleanup();
        resolve({ ok: true, bytes: bytes });
      };

      reader.onerror = function () {
        cleanup();
        resolve({ ok: false, bytes: 0 });
      };

      timeout = setTimeout(function () {
        cleanup();
        try { reader.abort(); } catch (e) {}
        resolve({ ok: false, bytes: 0 });
      }, Math.max(1000, parseIntOrNull(timeoutMs) || 0));

      try {
        reader.readAsArrayBuffer(blob);
      } catch (e) {
        cleanup();
        resolve({ ok: false, bytes: 0 });
      }
    });
  }

  // Validate that file is fully available (handles iCloud files still downloading)
  function validateFileReadable(file, opts) {
    var options = opts || {};
    var timeoutMs = parseIntOrNull(options.timeoutMs);
    if (timeoutMs == null) timeoutMs = 15000;

    return new Promise(function (resolve) {
      if (!file) {
        resolve(false);
        return;
      }

      var size = 0;
      try {
        size = typeof file.size === "number" ? file.size : 0;
      } catch (e) {
        size = 0;
      }

      if (!size || size <= 0) {
        resolve(false);
        return;
      }

      var type = "";
      try {
        type = String(file.type || "");
      } catch (e2) {
        type = "";
      }

      var isVideo = type.indexOf("video/") === 0;
      if (!isVideo && size < 1024 * 1024) {
        resolve(true);
        return;
      }

      var chunkSize = 65536;
      var headEnd = Math.min(chunkSize, size);
      var headBlob = file.slice(0, headEnd);

      readBlobAsArrayBuffer(headBlob, timeoutMs).then(function (head) {
        if (!head || !head.ok || head.bytes <= 0) {
          resolve(false);
          return;
        }

        var needTail = isVideo || size >= 1024 * 1024;
        if (!needTail || size <= chunkSize) {
          resolve(true);
          return;
        }

        var tailStart = Math.max(0, size - chunkSize);
        var tailBlob = file.slice(tailStart, size);
        readBlobAsArrayBuffer(tailBlob, timeoutMs).then(function (tail) {
          resolve(!!(tail && tail.ok && tail.bytes > 0));
        });
      });
    });
  }

  function showFileNotReadyWarning(fileName) {
    var WARNING_ID = "droppr-icloud-warning";
    var existing = document.getElementById(WARNING_ID);
    if (existing) existing.parentNode.removeChild(existing);

    var warning = document.createElement("div");
    warning.id = WARNING_ID;
    warning.style.cssText = "position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:2147483002;padding:16px 24px;border-radius:12px;background:rgba(220,38,38,0.95);color:#fff;font-family:Inter,system-ui,-apple-system,sans-serif;font-size:14px;font-weight:600;box-shadow:0 10px 40px rgba(0,0,0,0.4);max-width:90vw;text-align:center;";
    warning.innerHTML = '<div style="margin-bottom:8px;">File not ready: ' + (fileName || 'Unknown') + '</div>' +
      '<div style="font-weight:400;font-size:12px;opacity:0.9;">Please wait for the file to download from iCloud before uploading.</div>';

    document.body.appendChild(warning);

    setTimeout(function () {
      if (warning.parentNode) warning.parentNode.removeChild(warning);
    }, 6000);
  }

  function hasAnyZeroSize(files) {
    if (!files || !files.length) return false;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f) continue;
      try {
        if (typeof f.size === "number" && f.size === 0) return true;
      } catch (e) {
        // ignore
      }
    }
    return false;
  }

  function dispatchSyntheticChange(input) {
    var ev;
    try {
      ev = new Event("change", { bubbles: true, cancelable: true });
    } catch (e) {
      try {
        ev = document.createEvent("Event");
        ev.initEvent("change", true, true);
      } catch (e2) {
        return;
      }
    }

    fileInputBypass = true;
    try {
      input.dispatchEvent(ev);
    } finally {
      fileInputBypass = false;
    }
  }

  function waitForFilesReadable(files, opts) {
    var options = opts || {};
    var token = options.token || { canceled: false };
    var onStatus = options.onStatus || function () {};
    var maxWaitMs = parseIntOrNull(options.maxWaitMs);
    if (maxWaitMs == null) maxWaitMs = 20 * 60 * 1000;

    var start = nowMs();

    function elapsedSec() {
      return Math.max(0, Math.round((nowMs() - start) / 1000));
    }

    function waitOne(file, index, total) {
      var name = (file && file.name) ? String(file.name) : "file";
      var attempt = 0;

      function loop() {
        if (token.canceled) return Promise.resolve(false);
        if (nowMs() - start > maxWaitMs) return Promise.resolve(false);

        attempt += 1;
        var status = "Preparing " + (index + 1) + "/" + total + ": " + name + " (" + elapsedSec() + "s)";
        onStatus(status);

        return validateFileReadable(file, { timeoutMs: 15000 }).then(function (ok) {
          if (ok) return true;
          if (token.canceled) return false;
          if (nowMs() - start > maxWaitMs) return false;
          var delay = Math.min(8000, 600 + attempt * 450);
          return sleep(delay).then(loop);
        });
      }

      return loop();
    }

    var idx = 0;
    function next() {
      if (token.canceled) return Promise.resolve(false);
      if (idx >= files.length) return Promise.resolve(true);
      return waitOne(files[idx], idx, files.length).then(function (ok) {
        if (!ok) return false;
        idx += 1;
        return next();
      });
    }

    return next();
  }

  function patchFileInputs() {
    if (window.__dropprFileInputPatched) return;
    window.__dropprFileInputPatched = true;

    // Intercept file input change events
    document.addEventListener("change", function (e) {
      var input = e.target;
      if (!input || input.type !== "file" || !input.files || input.files.length === 0) return;
      if (fileInputBypass) return;

      var files = Array.prototype.slice.call(input.files);
      var shouldGate = isIOSDevice() || hasAnyZeroSize(files);
      if (!shouldGate) return;

      // Block FileBrowser from starting the upload until iOS/iCloud has a fully-readable file.
      e.stopImmediatePropagation();
      e.preventDefault();

      if (fileInputGate && fileInputGate.cancel) fileInputGate.cancel();

      var gate = { canceled: false, cancel: null };
      fileInputGate = gate;

      var overlay = null;
      var overlayTimer = null;
      var lastStatus = "Preparing upload…";

      function setStatus(text) {
        lastStatus = text || lastStatus;
        if (overlay && overlay.setStatus) overlay.setStatus(lastStatus);
      }

      function cleanupOverlay() {
        if (overlayTimer) {
          clearTimeout(overlayTimer);
          overlayTimer = null;
        }
        if (overlay && overlay.dismiss) overlay.dismiss();
        overlay = null;
      }

      gate.cancel = function () {
        gate.canceled = true;
        cleanupOverlay();
      };

      overlayTimer = setTimeout(function () {
        if (gate.canceled) return;
        // Another gate took over; don't show.
        if (fileInputGate !== gate) return;
        overlay = showIcloudWaitModal();
        overlay.setStatus(lastStatus);
        overlay.onCancel(function () {
          gate.canceled = true;
          cleanupOverlay();
          try { input.value = ""; } catch (e2) {}
        });
      }, 350);

      waitForFilesReadable(files, { token: gate, onStatus: setStatus, maxWaitMs: 20 * 60 * 1000 })
        .then(function (ok) {
          if (fileInputGate !== gate) return;
          cleanupOverlay();
          if (gate.canceled) return;
          if (ok) {
            dispatchSyntheticChange(input);
            return;
          }

          var name = files && files[0] && files[0].name ? files[0].name : "";
          showFileNotReadyWarning(name);
          try { input.value = ""; } catch (e3) {}
        })
        .catch(function () {
          if (fileInputGate !== gate) return;
          cleanupOverlay();
          if (gate.canceled) return;
          var name = files && files[0] && files[0].name ? files[0].name : "";
          showFileNotReadyWarning(name);
          try { input.value = ""; } catch (e4) {}
        });
    }, true);
  }

  // ============ UPLOAD REQUEST FUNCTIONALITY ============

  function ensureUploadRequestStyles() {
    if (document.getElementById(UPLOAD_REQUEST_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = UPLOAD_REQUEST_STYLE_ID;
    style.textContent =
      "#" + UPLOAD_REQUEST_FAB_ID + " {\n" +
      "  position: fixed;\n" +
      "  right: 20px;\n" +
      "  bottom: 20px;\n" +
      "  z-index: 2147483000;\n" +
      "  display: inline-flex;\n" +
      "  align-items: center;\n" +
      "  gap: 12px;\n" +
      "  padding: 18px 24px;\n" +
      "  border-radius: 16px;\n" +
      "  border: 1px solid rgba(255,255,255,0.24);\n" +
      "  background: rgba(14, 165, 233, 0.98);\n" +
      "  color: #ffffff;\n" +
      "  box-shadow: 0 22px 50px -22px rgba(2,132,199,0.9), 0 14px 28px -18px rgba(0,0,0,0.75);\n" +
      "  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;\n" +
      "  font-size: 18px;\n" +
      "  font-weight: 900;\n" +
      "  letter-spacing: -0.01em;\n" +
      "  line-height: 1;\n" +
      "  cursor: pointer;\n" +
      "  user-select: none;\n" +
      "  -webkit-tap-highlight-color: transparent;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_FAB_ID + ":hover {\n" +
      "  background: rgba(2, 132, 199, 0.99);\n" +
      "  transform: translateY(-1px);\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_FAB_ID + ":focus-visible {\n" +
      "  outline: 2px solid rgba(125, 211, 252, 0.95);\n" +
      "  outline-offset: 2px;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_FAB_ID + " .material-icons {\n" +
      "  font-size: 26px;\n" +
      "  line-height: 1;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_FAB_ID + " .label {\n" +
      "  white-space: nowrap;\n" +
      "}\n" +
      "@media (max-width: 680px) {\n" +
      "  #" + UPLOAD_REQUEST_FAB_ID + " {\n" +
      "    right: 10px;\n" +
      "    bottom: 10px;\n" +
      "    gap: 9px;\n" +
      "    padding: 14px 16px;\n" +
      "    font-size: 15px;\n" +
      "  }\n" +
      "  #" + UPLOAD_REQUEST_FAB_ID + " .label {\n" +
      "    max-width: 52vw;\n" +
      "    overflow: hidden;\n" +
      "    text-overflow: ellipsis;\n" +
      "  }\n" +
      "}\n" +
      "." + UPLOAD_REQUEST_BTN_CLASS + " {\n" +
      "  margin-left: 6px;\n" +
      "  background: #0ea5e9 !important;\n" +
      "}\n" +
      "." + UPLOAD_REQUEST_BTN_CLASS + ":hover {\n" +
      "  background: #0284c7 !important;\n" +
      "}\n" +
      "." + UPLOAD_REQUEST_BTN_CLASS + "[disabled] {\n" +
      "  opacity: 0.55;\n" +
      "  cursor: not-allowed;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " {\n" +
      "  position: fixed;\n" +
      "  right: 18px;\n" +
      "  bottom: 74px;\n" +
      "  z-index: 2147483001;\n" +
      "  width: 520px;\n" +
      "  max-width: calc(100vw - 36px);\n" +
      "  border-radius: 14px;\n" +
      "  background: var(--droppr-overlay-bg, rgba(17, 24, 39, 0.98));\n" +
      "  color: var(--text-primary, #e5e7eb);\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.12));\n" +
      "  box-shadow: 0 26px 60px -30px rgba(0,0,0,0.85);\n" +
      "  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;\n" +
      "  overflow: hidden;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .hdr {\n" +
      "  display: flex;\n" +
      "  align-items: flex-start;\n" +
      "  justify-content: space-between;\n" +
      "  gap: 12px;\n" +
      "  padding: 14px 14px 8px 14px;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .title {\n" +
      "  font-size: 14px;\n" +
      "  font-weight: 800;\n" +
      "  line-height: 1.2;\n" +
      "  color: var(--text-primary, #fff);\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .subtitle {\n" +
      "  font-size: 12px;\n" +
      "  line-height: 1.2;\n" +
      "  margin-top: 4px;\n" +
      "  color: var(--droppr-overlay-muted, rgba(229,231,235,0.8));\n" +
      "  word-break: break-word;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .close {\n" +
      "  appearance: none;\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.2));\n" +
      "  background: var(--hover-bg, rgba(255,255,255,0.08));\n" +
      "  color: var(--text-primary, #fff);\n" +
      "  width: 28px;\n" +
      "  height: 28px;\n" +
      "  border-radius: 10px;\n" +
      "  cursor: pointer;\n" +
      "  font-weight: 800;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .body {\n" +
      "  padding: 0 14px 14px 14px;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .field {\n" +
      "  margin-bottom: 12px;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .field label {\n" +
      "  display: block;\n" +
      "  font-size: 12px;\n" +
      "  color: var(--text-muted, #888);\n" +
      "  margin-bottom: 4px;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .field input[type='text'],\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .field input[type='password'],\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .field input[type='number'] {\n" +
      "  width: 100%;\n" +
      "  box-sizing: border-box;\n" +
      "  padding: 8px 10px;\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.15));\n" +
      "  border-radius: 8px;\n" +
      "  background: var(--input-bg, rgba(255,255,255,0.06));\n" +
      "  color: var(--text-primary, #fff);\n" +
      "  font-size: 13px;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .grid {\n" +
      "  display: grid;\n" +
      "  grid-template-columns: 1fr 1fr;\n" +
      "  gap: 10px;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .field.checkbox {\n" +
      "  display: flex;\n" +
      "  align-items: center;\n" +
      "  gap: 8px;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .field.checkbox input {\n" +
      "  width: 16px;\n" +
      "  height: 16px;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .actions {\n" +
      "  display: flex;\n" +
      "  gap: 10px;\n" +
      "  margin-top: 12px;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .btn {\n" +
      "  appearance: none;\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.15));\n" +
      "  background: var(--hover-bg, rgba(255,255,255,0.08));\n" +
      "  color: var(--text-primary, #fff);\n" +
      "  padding: 9px 11px;\n" +
      "  border-radius: 10px;\n" +
      "  cursor: pointer;\n" +
      "  font-weight: 800;\n" +
      "  font-size: 12px;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .btn.primary {\n" +
      "  background: #0ea5e9;\n" +
      "  border-color: rgba(255,255,255,0.0);\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .btn.primary:hover {\n" +
      "  background: #0284c7;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .btn.primary:disabled {\n" +
      "  opacity: 0.55;\n" +
      "  cursor: not-allowed;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .btn.secondary {\n" +
      "  background: transparent;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .note {\n" +
      "  font-size: 12px;\n" +
      "  margin-top: 10px;\n" +
      "  color: var(--text-secondary, rgba(229,231,235,0.7));\n" +
      "  line-height: 1.35;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .result {\n" +
      "  margin-top: 12px;\n" +
      "  padding-top: 12px;\n" +
      "  border-top: 1px solid var(--droppr-overlay-border-soft, rgba(255,255,255,0.08));\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .result .url-row {\n" +
      "  display: flex;\n" +
      "  gap: 8px;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .result input {\n" +
      "  flex: 1 1 auto;\n" +
      "  min-width: 0;\n" +
      "}\n" +
      "#" + UPLOAD_REQUEST_MODAL_ID + " .error {\n" +
      "  margin-top: 10px;\n" +
      "  padding: 10px;\n" +
      "  border-radius: 10px;\n" +
      "  background: rgba(239, 68, 68, 0.12);\n" +
      "  border: 1px solid rgba(239, 68, 68, 0.22);\n" +
      "  color: rgba(254, 202, 202, 0.95);\n" +
      "  font-size: 12px;\n" +
      "  line-height: 1.35;\n" +
      "}\n" +
      "@media (max-width: 520px) {\n" +
      "  #" + UPLOAD_REQUEST_MODAL_ID + " .grid { grid-template-columns: 1fr; }\n" +
      "}\n";
    document.head.appendChild(style);
  }

  function dismissUploadRequestModal() {
    var existing = document.getElementById(UPLOAD_REQUEST_MODAL_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  }

  function getDefaultUploadRequestExpireHours() {
    var stored = null;
    try {
      stored = localStorage.getItem(UPLOAD_REQUEST_EXPIRE_STORAGE_KEY);
    } catch (e) {
      stored = null;
    }
    var n = parseIntOrNull(stored);
    if (n == null || n < 0) return 168;
    return n;
  }

  function showUploadRequestCreationModal(path) {
    ensureUploadRequestStyles();
    dismissUploadRequestModal();

    var modal = document.createElement("div");
    modal.id = UPLOAD_REQUEST_MODAL_ID;

    var header = document.createElement("div");
    header.className = "hdr";

    var headerText = document.createElement("div");
    var title = document.createElement("div");
    title.className = "title";
    title.textContent = "Create File Request";

    var subtitle = document.createElement("div");
    subtitle.className = "subtitle";
    subtitle.textContent = "Recipients can upload to this folder (no account required)";

    headerText.appendChild(title);
    headerText.appendChild(subtitle);

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", dismissUploadRequestModal);

    header.appendChild(headerText);
    header.appendChild(closeBtn);

    var body = document.createElement("div");
    body.className = "body";

    // Path field (readonly)
    var pathField = document.createElement("div");
    pathField.className = "field";
    var pathLabel = document.createElement("label");
    pathLabel.textContent = "Destination folder";
    var pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.readOnly = true;
    pathInput.value = path;
    pathField.appendChild(pathLabel);
    pathField.appendChild(pathInput);

    // Title field
    var titleField = document.createElement("div");
    titleField.className = "field";
    var titleLabel = document.createElement("label");
    titleLabel.textContent = "Title (optional)";
    var titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.placeholder = "Upload files";
    titleField.appendChild(titleLabel);
    titleField.appendChild(titleInput);

    // Expiry field
    var expiryField = document.createElement("div");
    expiryField.className = "field";
    var expiryLabel = document.createElement("label");
    expiryLabel.textContent = "Expires in (hours) — 0 = never";
    var expiryInput = document.createElement("input");
    expiryInput.type = "number";
    expiryInput.min = "0";
    expiryInput.step = "1";
    expiryInput.value = String(getDefaultUploadRequestExpireHours());
    expiryField.appendChild(expiryLabel);
    expiryField.appendChild(expiryInput);

    // Password checkbox + field
    var pwCheckField = document.createElement("div");
    pwCheckField.className = "field checkbox";
    var pwCheckbox = document.createElement("input");
    pwCheckbox.type = "checkbox";
    pwCheckbox.id = "droppr-uploadreq-pw-enabled";
    var pwCheckLabel = document.createElement("label");
    pwCheckLabel.setAttribute("for", pwCheckbox.id);
    pwCheckLabel.textContent = "Password protect";
    pwCheckField.appendChild(pwCheckbox);
    pwCheckField.appendChild(pwCheckLabel);

    var pwField = document.createElement("div");
    pwField.className = "field";
    pwField.style.display = "none";
    var pwLabel = document.createElement("label");
    pwLabel.textContent = "Password";
    var pwInput = document.createElement("input");
    pwInput.type = "password";
    pwInput.placeholder = "Enter password";
    pwField.appendChild(pwLabel);
    pwField.appendChild(pwInput);

    pwCheckbox.addEventListener("change", function () {
      pwField.style.display = pwCheckbox.checked ? "block" : "none";
    });

    // Grid fields (limits)
    var grid = document.createElement("div");
    grid.className = "grid";

    var maxFilesField = document.createElement("div");
    maxFilesField.className = "field";
    var maxFilesLabel = document.createElement("label");
    maxFilesLabel.textContent = "Max files (0 = unlimited)";
    var maxFilesInput = document.createElement("input");
    maxFilesInput.type = "number";
    maxFilesInput.min = "0";
    maxFilesInput.step = "1";
    maxFilesInput.value = "0";
    maxFilesField.appendChild(maxFilesLabel);
    maxFilesField.appendChild(maxFilesInput);

    var maxSizeField = document.createElement("div");
    maxSizeField.className = "field";
    var maxSizeLabel = document.createElement("label");
    maxSizeLabel.textContent = "Max file size (MB)";
    var maxSizeInput = document.createElement("input");
    maxSizeInput.type = "number";
    maxSizeInput.min = "0";
    maxSizeInput.step = "1";
    maxSizeInput.max = "204800";
    maxSizeInput.value = "204800";
    maxSizeField.appendChild(maxSizeLabel);
    maxSizeField.appendChild(maxSizeInput);

    grid.appendChild(maxFilesField);
    grid.appendChild(maxSizeField);

    // Allowed extensions
    var extsField = document.createElement("div");
    extsField.className = "field";
    var extsLabel = document.createElement("label");
    extsLabel.textContent = "Allowed extensions (optional, comma-separated; leave empty for all file extensions)";
    var extsInput = document.createElement("input");
    extsInput.type = "text";
    extsInput.placeholder = "jpg,png,mp4,mov";
    extsField.appendChild(extsLabel);
    extsField.appendChild(extsInput);

    // Overwrite + subfolder checkboxes
    var overwriteField = document.createElement("div");
    overwriteField.className = "field checkbox";
    var overwriteCheckbox = document.createElement("input");
    overwriteCheckbox.type = "checkbox";
    overwriteCheckbox.id = "droppr-uploadreq-overwrite";
    var overwriteLabel = document.createElement("label");
    overwriteLabel.setAttribute("for", overwriteCheckbox.id);
    overwriteLabel.textContent = "Overwrite existing filenames";
    overwriteField.appendChild(overwriteCheckbox);
    overwriteField.appendChild(overwriteLabel);

    var subfolderField = document.createElement("div");
    subfolderField.className = "field checkbox";
    var subfolderCheckbox = document.createElement("input");
    subfolderCheckbox.type = "checkbox";
    subfolderCheckbox.id = "droppr-uploadreq-subfolder";
    subfolderCheckbox.checked = true;
    var subfolderLabel = document.createElement("label");
    subfolderLabel.setAttribute("for", subfolderCheckbox.id);
    subfolderLabel.textContent = "Create a per-request subfolder (recommended)";
    subfolderField.appendChild(subfolderCheckbox);
    subfolderField.appendChild(subfolderLabel);

    var shareBackField = document.createElement("div");
    shareBackField.className = "field checkbox";
    var shareBackCheckbox = document.createElement("input");
    shareBackCheckbox.type = "checkbox";
    shareBackCheckbox.id = "droppr-uploadreq-shareback";
    shareBackCheckbox.checked = true;
    var shareBackLabel = document.createElement("label");
    shareBackLabel.setAttribute("for", shareBackCheckbox.id);
    shareBackLabel.textContent = "Show a view link after upload (share back)";
    shareBackField.appendChild(shareBackCheckbox);
    shareBackField.appendChild(shareBackLabel);

    subfolderCheckbox.addEventListener("change", function () {
      var enabled = !!subfolderCheckbox.checked;
      shareBackCheckbox.disabled = !enabled;
      if (!enabled) shareBackCheckbox.checked = false;
    });

    // Actions
    var actions = document.createElement("div");
    actions.className = "actions";
    var createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "btn primary";
    createBtn.textContent = "Create Link";
    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", dismissUploadRequestModal);
    actions.appendChild(createBtn);
    actions.appendChild(cancelBtn);

    var note = document.createElement("div");
    note.className = "note";
    note.textContent = "Tip: disable the request after the upload is done. For large uploads, keep the browser tab open until it completes.";

    var resultContainer = document.createElement("div");
    resultContainer.className = "result";
    resultContainer.style.display = "none";

    var errorContainer = document.createElement("div");
    errorContainer.className = "error";
    errorContainer.style.display = "none";

    body.appendChild(pathField);
    body.appendChild(titleField);
    body.appendChild(expiryField);
    body.appendChild(pwCheckField);
    body.appendChild(pwField);
    body.appendChild(grid);
    body.appendChild(extsField);
    body.appendChild(overwriteField);
    body.appendChild(subfolderField);
    body.appendChild(shareBackField);
    body.appendChild(actions);
    body.appendChild(note);
    body.appendChild(resultContainer);
    body.appendChild(errorContainer);

    modal.appendChild(header);
    modal.appendChild(body);
    document.body.appendChild(modal);

    createBtn.addEventListener("click", function () {
      errorContainer.style.display = "none";
      resultContainer.style.display = "none";

      var expiresHours = parseIntOrNull(expiryInput.value);
      if (expiresHours == null || expiresHours < 0) expiresHours = 0;
      try {
        localStorage.setItem(UPLOAD_REQUEST_EXPIRE_STORAGE_KEY, String(expiresHours));
      } catch (e) {}

      var maxFiles = parseIntOrNull(maxFilesInput.value);
      if (maxFiles == null || maxFiles < 0) maxFiles = 0;

      var maxMb = parseIntOrNull(maxSizeInput.value);
      if (maxMb == null || maxMb < 0) maxMb = 0;

      if (pwCheckbox.checked && !String(pwInput.value || "").trim()) {
        errorContainer.textContent = "Password is enabled but empty.";
        errorContainer.style.display = "block";
        return;
      }

      var token = getAuthToken();
      if (!token) {
        errorContainer.textContent = "Not logged in.";
        errorContainer.style.display = "block";
        return;
      }

      createBtn.disabled = true;
      createBtn.textContent = "Creating…";

      var payload = {
        path: path,
        title: titleInput.value || "",
        password: pwCheckbox.checked ? pwInput.value : "",
        expires_hours: expiresHours,
        max_files: maxFiles,
        max_file_size_mb: maxMb,
        allowed_exts: extsInput.value || "",
        overwrite: !!overwriteCheckbox.checked,
        create_subfolder: !!subfolderCheckbox.checked,
        share_back: !!shareBackCheckbox.checked,
      };

      fetch("/api/upload-request/create", {
        method: "POST",
        headers: { "X-Auth": token, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (resp) {
          return resp.text().then(function (text) {
            if (!resp.ok) {
              var msg = text || "";
              try {
                var parsed = JSON.parse(text);
                if (parsed && parsed.error) msg = String(parsed.error);
              } catch (e) {}
              throw new Error(msg || ("Failed (" + resp.status + ")"));
            }
            try {
              return JSON.parse(text || "{}");
            } catch (e2) {
              return {};
            }
          });
        })
        .then(function (data) {
          var rel = data && data.upload_url ? String(data.upload_url) : "";
          if (!rel) throw new Error("Server did not return upload_url");
          var uploadUrl = window.location.origin + rel;

          var urlRow = document.createElement("div");
          urlRow.className = "url-row";
          var urlInput = document.createElement("input");
          urlInput.type = "text";
          urlInput.readOnly = true;
          urlInput.value = uploadUrl;
          urlInput.addEventListener("focus", function () {
            try { urlInput.select(); } catch (e3) {}
          });

          var copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = "btn primary";
          copyBtn.textContent = "Copy";
          copyBtn.addEventListener("click", function () {
            copyText(uploadUrl)
              .then(function () {
                copyBtn.textContent = "Copied!";
                setTimeout(function () {
                  if (document.body.contains(copyBtn)) copyBtn.textContent = "Copy";
                }, 1200);
              })
              .catch(function () {
                try { urlInput.focus(); urlInput.select(); } catch (e4) {}
              });
          });

          var openBtn = document.createElement("button");
          openBtn.type = "button";
          openBtn.className = "btn secondary";
          openBtn.textContent = "Open";
          openBtn.addEventListener("click", function () {
            try { window.open(uploadUrl, "_blank", "noopener"); }
            catch (e5) { window.location.href = uploadUrl; }
          });

          urlRow.appendChild(urlInput);
          urlRow.appendChild(copyBtn);
          urlRow.appendChild(openBtn);

          resultContainer.innerHTML = "";
          resultContainer.appendChild(urlRow);
          resultContainer.style.display = "block";

          copyText(uploadUrl).catch(function () {});
        })
        .catch(function (err) {
          errorContainer.textContent = String(err && err.message ? err.message : err);
          errorContainer.style.display = "block";
        })
        .then(function () {
          createBtn.disabled = false;
          createBtn.textContent = "Create Link";
        });
    });
  }

  function normalizeCompactText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isElementVisible(el) {
    if (!el) return false;
    try {
      if (el.offsetParent) return true;
      var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      return !!(rect && rect.width > 0 && rect.height > 0);
    } catch (e) {
      return true;
    }
  }

  function findUploadRequestMenuContext() {
    if (!document.querySelectorAll) return null;

    var nodeList = document.querySelectorAll("a, button, [role='button'], .v-list-item");
    if (!nodeList || !nodeList.length) return null;

    var candidates = [];
    for (var i = 0; i < nodeList.length; i++) {
      var el = nodeList[i];
      if (!el || el.id === UPLOAD_REQUEST_MENU_ID) continue;
      if (!isElementVisible(el)) continue;

      var text = normalizeCompactText(el.textContent);
      if (!text) continue;
      var isMenuText =
        text.indexOf("my files") !== -1 ||
        text.indexOf("new folder") !== -1 ||
        text.indexOf("new file") !== -1 ||
        text.indexOf("settings") !== -1 ||
        text.indexOf("logout") !== -1;
      if (!isMenuText) continue;

      var rect = null;
      try {
        rect = el.getBoundingClientRect();
      } catch (e2) {
        rect = null;
      }
      if (!rect || rect.width < 24 || rect.height < 16) continue;
      if (rect.left > Math.max(320, window.innerWidth * 0.45)) continue;

      candidates.push({ el: el, text: text, rect: rect });
    }

    if (!candidates.length) return null;

    var minLeft = candidates[0].rect.left;
    for (var j = 1; j < candidates.length; j++) {
      if (candidates[j].rect.left < minLeft) minLeft = candidates[j].rect.left;
    }

    var leftBand = [];
    for (var k = 0; k < candidates.length; k++) {
      if (candidates[k].rect.left <= minLeft + 80) leftBand.push(candidates[k]);
    }
    if (!leftBand.length) leftBand = candidates;

    leftBand.sort(function (a, b) {
      if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
      return a.rect.left - b.rect.left;
    });

    var template = null;
    for (var m = 0; m < leftBand.length; m++) {
      if (leftBand[m].text.indexOf("new file") !== -1) {
        template = leftBand[m].el;
        break;
      }
    }
    if (!template) {
      for (var n = 0; n < leftBand.length; n++) {
        if (leftBand[n].text.indexOf("new folder") !== -1) {
          template = leftBand[n].el;
          break;
        }
      }
    }
    if (!template) template = leftBand[0].el;
    if (!template || !template.parentNode) return null;

    var parent = template.parentNode;
    var beforeEl = null;
    for (var p = 0; p < leftBand.length; p++) {
      if (leftBand[p].el.parentNode !== parent) continue;
      if (leftBand[p].text.indexOf("settings") !== -1 || leftBand[p].text.indexOf("logout") !== -1) {
        beforeEl = leftBand[p].el;
        break;
      }
    }

    return { parent: parent, template: template, beforeEl: beforeEl };
  }

  function setUploadRequestMenuItemContent(itemEl) {
    if (!itemEl) return;

    var icon = itemEl.querySelector
      ? (itemEl.querySelector(".material-icons") || itemEl.querySelector("i.material-icons"))
      : null;
    if (icon && String(icon.textContent || "").trim() !== "file_upload") icon.textContent = "file_upload";

    var labelEl = itemEl.querySelector
      ? (itemEl.querySelector(".v-list-item__title") ||
         itemEl.querySelector(".label") ||
         itemEl.querySelector(".name") ||
         itemEl.querySelector(".title") ||
         itemEl.querySelector(".text"))
      : null;
    if (labelEl && labelEl !== icon) {
      if (String(labelEl.textContent || "").trim() !== "Create File Request") {
        labelEl.textContent = "Create File Request";
      }
      return;
    }

    var textSet = false;
    function setFirstTextNode(node) {
      if (!node || textSet) return;
      var child = node.firstChild;
      while (child) {
        if (child.nodeType === 3 && String(child.nodeValue || "").trim()) {
          if (String(child.nodeValue || "") !== "Create File Request") {
            child.nodeValue = "Create File Request";
          }
          textSet = true;
          return;
        }
        if (child.nodeType === 1) {
          if (!(icon && (child === icon || (child.contains && child.contains(icon))))) {
            setFirstTextNode(child);
            if (textSet) return;
          }
        }
        child = child.nextSibling;
      }
    }
    setFirstTextNode(itemEl);

    if (!textSet) {
      var span = document.createElement("span");
      span.textContent = "Create File Request";
      itemEl.appendChild(span);
    }
  }

  function resolveUploadRequestDestPath() {
    var rowEl = getSelectedFilesRowEl();
    var decodedPath = extractSelectedPathFromFilesRow(rowEl);
    if (decodedPath) return decodedPath;

    if (isFilesPage()) {
      var dir = getFilesDirPath();
      if (dir && dir !== "/") return dir;
    }
    return null;
  }

  function bindUploadRequestMenuItem(itemEl) {
    if (!itemEl || itemEl.getAttribute("data-droppr-upload-request-bound") === "1") return;
    itemEl.setAttribute("data-droppr-upload-request-bound", "1");

    var handler = function (e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }

      var decodedPath = resolveUploadRequestDestPath();
      if (!decodedPath) {
        showAutoShareModal({
          title: "Select a destination folder",
          subtitle: "",
          url: "",
          note: "Open Files, go to the destination folder, then click Create File Request again.",
          autoCopy: false,
        });
        return;
      }
      showUploadRequestCreationModal(decodedPath);
    };

    itemEl.addEventListener("click", handler);
    itemEl.addEventListener("keydown", function (e) {
      var key = String(e && e.key || "");
      if (key !== "Enter" && key !== " ") return;
      handler(e);
    });
  }

  function ensureUploadRequestButton() {
    var tNow = nowMs();
    if (tNow - uploadRequestMenuLastEnsureAt < 250) return;
    uploadRequestMenuLastEnsureAt = tNow;

    // Remove legacy inline clones/floating action button.
    var inlineButtons = document.querySelectorAll ? document.querySelectorAll("." + UPLOAD_REQUEST_BTN_CLASS) : [];
    for (var i = 0; i < inlineButtons.length; i++) {
      var oldBtn = inlineButtons[i];
      if (!oldBtn) continue;
      if (oldBtn.parentNode) oldBtn.parentNode.removeChild(oldBtn);
    }

    var floatingBtn = document.getElementById(UPLOAD_REQUEST_FAB_ID);
    if (floatingBtn && floatingBtn.parentNode) floatingBtn.parentNode.removeChild(floatingBtn);

    var existing = document.getElementById(UPLOAD_REQUEST_MENU_ID);
    if (!isLoggedIn()) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }

    ensureUploadRequestStyles();
    var ctx = findUploadRequestMenuContext();
    if (!ctx || !ctx.parent || !ctx.template) return;

    if (!existing) {
      existing = ctx.template.cloneNode(true);
      if (existing.removeAttribute) {
        existing.removeAttribute("href");
        existing.removeAttribute("to");
      }
      if (existing.classList) {
        existing.classList.remove("active");
        existing.classList.remove("selected");
        existing.classList.remove("v-list-item--active");
        existing.classList.remove("router-link-active");
        existing.classList.remove("router-link-exact-active");
      }
      existing.id = UPLOAD_REQUEST_MENU_ID;
      existing.setAttribute("role", "button");
      existing.setAttribute("tabindex", "0");
      existing.setAttribute("aria-label", "Create File Request");
      existing.title = "Create File Request";

      var dupeIds = existing.querySelectorAll ? existing.querySelectorAll("[id]") : [];
      for (var d = 0; d < dupeIds.length; d++) dupeIds[d].removeAttribute("id");

      setUploadRequestMenuItemContent(existing);
      bindUploadRequestMenuItem(existing);
      existing.setAttribute("data-droppr-upload-request-labeled", "1");
    } else {
      if (existing.getAttribute("data-droppr-upload-request-labeled") !== "1") {
        setUploadRequestMenuItemContent(existing);
        existing.setAttribute("data-droppr-upload-request-labeled", "1");
      }
      if (existing.getAttribute("data-droppr-upload-request-bound") !== "1") {
        bindUploadRequestMenuItem(existing);
      }
    }

    if (ctx.beforeEl && ctx.beforeEl.parentNode === ctx.parent) {
      if (existing !== ctx.beforeEl.previousElementSibling) {
        ctx.parent.insertBefore(existing, ctx.beforeEl);
      }
    } else if (existing.parentNode !== ctx.parent) {
      ctx.parent.appendChild(existing);
    }
  }

  // ============ ROBUST SHARE FUNCTIONALITY ============

  function ensureRobustShareStyles() {
    if (document.getElementById(ROBUST_SHARE_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = ROBUST_SHARE_STYLE_ID;
    style.textContent =
      "." + ROBUST_SHARE_BTN_CLASS + " {\n" +
      "  margin-left: 6px;\n" +
      "  background: #059669 !important;\n" +
      "}\n" +
      "." + ROBUST_SHARE_BTN_CLASS + ":hover {\n" +
      "  background: #047857 !important;\n" +
      "}\n" +
      "." + ROBUST_SHARE_BTN_CLASS + "[disabled] {\n" +
      "  opacity: 0.55;\n" +
      "  cursor: not-allowed;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " {\n" +
      "  position: fixed;\n" +
      "  right: 18px;\n" +
      "  bottom: 74px;\n" +
      "  z-index: 2147483001;\n" +
      "  width: 480px;\n" +
      "  max-width: calc(100vw - 36px);\n" +
      "  border-radius: 14px;\n" +
      "  background: var(--droppr-overlay-bg, rgba(17, 24, 39, 0.98));\n" +
      "  color: var(--text-primary, #e5e7eb);\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.12));\n" +
      "  box-shadow: 0 26px 60px -30px rgba(0,0,0,0.85);\n" +
      "  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;\n" +
      "  overflow: hidden;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .hdr {\n" +
      "  display: flex;\n" +
      "  align-items: flex-start;\n" +
      "  justify-content: space-between;\n" +
      "  gap: 12px;\n" +
      "  padding: 14px 14px 8px 14px;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .title {\n" +
      "  font-size: 14px;\n" +
      "  font-weight: 800;\n" +
      "  line-height: 1.2;\n" +
      "  color: var(--text-primary, #fff);\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .subtitle {\n" +
      "  font-size: 12px;\n" +
      "  line-height: 1.2;\n" +
      "  margin-top: 4px;\n" +
      "  color: var(--droppr-overlay-muted, rgba(229,231,235,0.8));\n" +
      "  word-break: break-word;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .close {\n" +
      "  appearance: none;\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.2));\n" +
      "  background: var(--hover-bg, rgba(255,255,255,0.08));\n" +
      "  color: var(--text-primary, #fff);\n" +
      "  width: 28px;\n" +
      "  height: 28px;\n" +
      "  border-radius: 10px;\n" +
      "  cursor: pointer;\n" +
      "  font-weight: 800;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .body {\n" +
      "  padding: 0 14px 14px 14px;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .field {\n" +
      "  margin-bottom: 12px;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .field label {\n" +
      "  display: block;\n" +
      "  font-size: 12px;\n" +
      "  color: var(--text-muted, #888);\n" +
      "  margin-bottom: 4px;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .field input[type='text'],\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .field input[type='password'],\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .field input[type='number'] {\n" +
      "  width: 100%;\n" +
      "  box-sizing: border-box;\n" +
      "  padding: 8px 10px;\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.15));\n" +
      "  border-radius: 8px;\n" +
      "  background: var(--input-bg, rgba(255,255,255,0.06));\n" +
      "  color: var(--text-primary, #fff);\n" +
      "  font-size: 13px;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .field.checkbox {\n" +
      "  display: flex;\n" +
      "  align-items: center;\n" +
      "  gap: 8px;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .field.checkbox input {\n" +
      "  width: 16px;\n" +
      "  height: 16px;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .field.checkbox label {\n" +
      "  margin-bottom: 0;\n" +
      "  font-size: 13px;\n" +
      "  color: var(--text-primary, #fff);\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .actions {\n" +
      "  display: flex;\n" +
      "  gap: 8px;\n" +
      "  margin-top: 12px;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .btn {\n" +
      "  padding: 8px 16px;\n" +
      "  border: none;\n" +
      "  border-radius: 8px;\n" +
      "  font-size: 13px;\n" +
      "  font-weight: 600;\n" +
      "  cursor: pointer;\n" +
      "  transition: background 0.15s;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .btn.primary {\n" +
      "  background: #059669;\n" +
      "  color: #fff;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .btn.primary:hover {\n" +
      "  background: #047857;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .btn.primary:disabled {\n" +
      "  background: #6b7280;\n" +
      "  cursor: not-allowed;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .btn.secondary {\n" +
      "  background: var(--hover-bg, rgba(255,255,255,0.08));\n" +
      "  color: var(--text-primary, #fff);\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.15));\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .note {\n" +
      "  margin-top: 12px;\n" +
      "  font-size: 11px;\n" +
      "  color: var(--text-muted, #888);\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .result {\n" +
      "  margin-top: 12px;\n" +
      "  padding: 10px;\n" +
      "  background: var(--success-bg, rgba(5, 150, 105, 0.15));\n" +
      "  border: 1px solid rgba(5, 150, 105, 0.3);\n" +
      "  border-radius: 8px;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .result .url-row {\n" +
      "  display: flex;\n" +
      "  gap: 8px;\n" +
      "  margin-top: 8px;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .result input {\n" +
      "  flex: 1;\n" +
      "  padding: 6px 8px;\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.15));\n" +
      "  border-radius: 6px;\n" +
      "  background: var(--input-bg, rgba(255,255,255,0.06));\n" +
      "  color: var(--text-primary, #fff);\n" +
      "  font-size: 12px;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .result .btn {\n" +
      "  padding: 6px 12px;\n" +
      "  font-size: 12px;\n" +
      "}\n" +
      "#" + ROBUST_SHARE_MODAL_ID + " .error {\n" +
      "  margin-top: 8px;\n" +
      "  padding: 8px;\n" +
      "  background: rgba(220, 38, 38, 0.15);\n" +
      "  border: 1px solid rgba(220, 38, 38, 0.3);\n" +
      "  border-radius: 6px;\n" +
      "  color: #fca5a5;\n" +
      "  font-size: 12px;\n" +
      "}\n";
    document.head.appendChild(style);
  }

  function dismissRobustShareModal() {
    var existing = document.getElementById(ROBUST_SHARE_MODAL_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
  }

  function showRobustShareCreationModal(path) {
    ensureRobustShareStyles();
    dismissRobustShareModal();

    var modal = document.createElement("div");
    modal.id = ROBUST_SHARE_MODAL_ID;

    var header = document.createElement("div");
    header.className = "hdr";

    var headerText = document.createElement("div");
    var title = document.createElement("div");
    title.className = "title";
    title.textContent = "Create Robust Share";

    var subtitle = document.createElement("div");
    subtitle.className = "subtitle";
    subtitle.textContent = "Large file support (up to 100GB) with resume capability";

    headerText.appendChild(title);
    headerText.appendChild(subtitle);

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", dismissRobustShareModal);

    header.appendChild(headerText);
    header.appendChild(closeBtn);

    var body = document.createElement("div");
    body.className = "body";

    // Path field (readonly)
    var pathField = document.createElement("div");
    pathField.className = "field";
    var pathLabel = document.createElement("label");
    pathLabel.textContent = "Path";
    var pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.readOnly = true;
    pathInput.value = path;
    pathField.appendChild(pathLabel);
    pathField.appendChild(pathInput);

    // Title field
    var titleField = document.createElement("div");
    titleField.className = "field";
    var titleLabel = document.createElement("label");
    titleLabel.textContent = "Title (optional)";
    var titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.placeholder = "My Files";
    titleInput.id = "robust-share-title";
    titleField.appendChild(titleLabel);
    titleField.appendChild(titleInput);

    // Expiry field
    var expiryField = document.createElement("div");
    expiryField.className = "field";
    var expiryLabel = document.createElement("label");
    expiryLabel.textContent = "Expires in (hours) — 0 = never";
    var expiryInput = document.createElement("input");
    expiryInput.type = "number";
    expiryInput.min = "0";
    expiryInput.step = "1";
    var defaultExpire = null;
    try {
      defaultExpire = localStorage.getItem(ROBUST_SHARE_EXPIRE_STORAGE_KEY);
    } catch (e) {
      defaultExpire = null;
    }
    var defaultExpireHours = parseIntOrNull(defaultExpire);
    if (defaultExpireHours == null || defaultExpireHours < 0) defaultExpireHours = 168;
    expiryInput.value = String(defaultExpireHours);
    expiryField.appendChild(expiryLabel);
    expiryField.appendChild(expiryInput);

    // Password checkbox
    var pwCheckField = document.createElement("div");
    pwCheckField.className = "field checkbox";
    var pwCheckbox = document.createElement("input");
    pwCheckbox.type = "checkbox";
    pwCheckbox.id = "robust-share-pw-enabled";
    var pwCheckLabel = document.createElement("label");
    pwCheckLabel.setAttribute("for", "robust-share-pw-enabled");
    pwCheckLabel.textContent = "Password protect";
    pwCheckField.appendChild(pwCheckbox);
    pwCheckField.appendChild(pwCheckLabel);

    // Password field
    var pwField = document.createElement("div");
    pwField.className = "field";
    pwField.style.display = "none";
    var pwLabel = document.createElement("label");
    pwLabel.textContent = "Password";
    var pwInput = document.createElement("input");
    pwInput.type = "password";
    pwInput.id = "robust-share-password";
    pwInput.placeholder = "Enter password";
    pwField.appendChild(pwLabel);
    pwField.appendChild(pwInput);

    pwCheckbox.addEventListener("change", function() {
      pwField.style.display = pwCheckbox.checked ? "block" : "none";
    });

    // Actions
    var actions = document.createElement("div");
    actions.className = "actions";
    var createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "btn primary";
    createBtn.textContent = "Create Share";
    createBtn.id = "robust-share-create-btn";
    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", dismissRobustShareModal);
    actions.appendChild(createBtn);
    actions.appendChild(cancelBtn);

    // Note
    var note = document.createElement("div");
    note.className = "note";
    note.textContent = "Recipients can download all files or select individual files. Large files up to 100GB supported with resume capability.";

    // Result container (hidden initially)
    var resultContainer = document.createElement("div");
    resultContainer.className = "result";
    resultContainer.style.display = "none";

    // Error container (hidden initially)
    var errorContainer = document.createElement("div");
    errorContainer.className = "error";
    errorContainer.style.display = "none";

    body.appendChild(pathField);
    body.appendChild(titleField);
    body.appendChild(expiryField);
    body.appendChild(pwCheckField);
    body.appendChild(pwField);
    body.appendChild(actions);
    body.appendChild(note);
    body.appendChild(resultContainer);
    body.appendChild(errorContainer);

    modal.appendChild(header);
    modal.appendChild(body);
    document.body.appendChild(modal);

    // Create button handler
    createBtn.addEventListener("click", function() {
      createBtn.disabled = true;
      createBtn.textContent = "Creating...";
      errorContainer.style.display = "none";
      resultContainer.style.display = "none";

      var expiresHours = parseIntOrNull(expiryInput.value);
      if (expiresHours == null || expiresHours < 0) expiresHours = 0;
      try {
        localStorage.setItem(ROBUST_SHARE_EXPIRE_STORAGE_KEY, String(expiresHours));
      } catch (e2) {}

      if (pwCheckbox.checked && !String(pwInput.value || "").trim()) {
        createBtn.disabled = false;
        createBtn.textContent = "Create Share";
        errorContainer.textContent = "Password is enabled but empty.";
        errorContainer.style.display = "block";
        return;
      }

      var payload = {
        path: path,
        title: titleInput.value || "",
        password: pwCheckbox.checked ? pwInput.value : "",
        expires_hours: expiresHours,
      };

      var token = getAuthToken();
      fetch("/api/robust-share/create", {
        method: "POST",
        headers: {
          "X-Auth": token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      })
      .then(function(resp) {
        if (!resp.ok) {
          return resp.json().then(function(data) {
            throw new Error(data.error || "Failed to create share");
          });
        }
        return resp.json();
      })
      .then(function(data) {
        createBtn.textContent = "Created!";
        createBtn.style.background = "#10b981";

        var shareUrl = window.location.origin + data.share_url;

        // Show result
        resultContainer.innerHTML = "";
        var resultTitle = document.createElement("div");
        resultTitle.style.fontWeight = "700";
        resultTitle.style.marginBottom = "4px";
        resultTitle.textContent = "Share link created!";
        resultContainer.appendChild(resultTitle);

        var resultInfo = document.createElement("div");
        resultInfo.style.fontSize = "12px";
        resultInfo.style.marginBottom = "8px";
        resultInfo.style.color = "var(--text-muted, #888)";
        resultInfo.textContent = data.file_count + " file(s) • " + formatBytes(data.total_size);
        resultContainer.appendChild(resultInfo);

        var urlRow = document.createElement("div");
        urlRow.className = "url-row";
        var urlInput = document.createElement("input");
        urlInput.type = "text";
        urlInput.readOnly = true;
        urlInput.value = shareUrl;
        urlInput.addEventListener("focus", function() {
          try { urlInput.select(); } catch(e) {}
        });
        var copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "btn primary";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", function() {
          copyText(shareUrl)
            .then(function() {
              copyBtn.textContent = "Copied!";
              setTimeout(function() {
                if (document.body.contains(copyBtn)) copyBtn.textContent = "Copy";
              }, 1200);
            })
            .catch(function() {
              try { urlInput.focus(); urlInput.select(); } catch(e) {}
            });
        });
        var openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "btn secondary";
        openBtn.textContent = "Open";
        openBtn.addEventListener("click", function() {
          try { window.open(shareUrl, "_blank", "noopener"); }
          catch(e) { window.location.href = shareUrl; }
        });
        urlRow.appendChild(urlInput);
        urlRow.appendChild(copyBtn);
        urlRow.appendChild(openBtn);
        resultContainer.appendChild(urlRow);

        resultContainer.style.display = "block";

        // Auto-copy
        copyText(shareUrl).catch(function() {});
      })
      .catch(function(err) {
        createBtn.disabled = false;
        createBtn.textContent = "Create Share";
        errorContainer.textContent = err.message || "Failed to create share";
        errorContainer.style.display = "block";
      });
    });
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    var k = 1024;
    var sizes = ["B", "KB", "MB", "GB", "TB"];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  function ensureRobustShareButton() {
    if (!isLoggedIn()) return;
    if (!isFilesPage()) return;

    ensureRobustShareStyles();

    function isInDialogOrMenu(el) {
      try {
        return !!(
          el &&
          el.closest &&
          (el.closest(".v-dialog__content--active") ||
            el.closest(".v-dialog--active") ||
            el.closest(".v-menu__content") ||
            el.closest("[role=\"dialog\"]"))
        );
      } catch (e) {
        return false;
      }
    }

    function isVisible(el) {
      if (!el) return false;
      try {
        if (el.offsetParent) return true;
        var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        return !!(rect && rect.width > 0 && rect.height > 0);
      } catch (e) {
        return true;
      }
    }

    function attachToShareButton(shareBtn) {
      if (!shareBtn) return false;
      if (shareBtn.classList && shareBtn.classList.contains(ROBUST_SHARE_BTN_CLASS)) return false;
      if (isInDialogOrMenu(shareBtn)) return false;
      if (!isVisible(shareBtn)) return false;

      var host = shareBtn.parentNode;
      if (!host || !host.insertBefore) return false;

      var disabled =
        !!shareBtn.disabled ||
        shareBtn.getAttribute("disabled") != null ||
        shareBtn.getAttribute("aria-disabled") === "true" ||
        (shareBtn.classList && shareBtn.classList.contains("v-btn--disabled"));

      var existing = host.querySelector ? host.querySelector("." + ROBUST_SHARE_BTN_CLASS) : null;
      if (existing) {
        existing.disabled = disabled;
        try {
          if (existing.classList) {
            if (disabled) existing.classList.add("v-btn--disabled");
            else existing.classList.remove("v-btn--disabled");
          }
        } catch (e3) {}

        try {
          existing.style.display = shareBtn.style && shareBtn.style.display === "none" ? "none" : "";
        } catch (e4) {}
        return true;
      }

      var newBtn = shareBtn.cloneNode(true);
      if (newBtn.classList && newBtn.classList.add) newBtn.classList.add(ROBUST_SHARE_BTN_CLASS);
      newBtn.title = "Robust Share (Large Files up to 100GB)";
      newBtn.setAttribute("aria-label", "Robust Share (Large Files up to 100GB)");
      setMaterialIconText(newBtn, "cloud_upload");
      newBtn.disabled = disabled;

      newBtn.addEventListener("click", function(e) {
        e.preventDefault();
        e.stopPropagation();

        var rowEl = getSelectedFilesRowEl();
        var decodedPath = extractSelectedPathFromFilesRow(rowEl);
        if (!decodedPath) {
          showAutoShareModal({
            title: "Select a file or folder",
            subtitle: "",
            url: "",
            note: "Select a file/folder in the list first, then click Robust Share again.",
            autoCopy: false,
          });
          return;
        }

        showRobustShareCreationModal(decodedPath);
      });

      // Insert after the quick share button if it exists, otherwise after stream share button
      var quickShareBtn = host.querySelector ? host.querySelector("." + QUICK_SHARE_BTN_CLASS) : null;
      if (quickShareBtn) {
        host.insertBefore(newBtn, quickShareBtn.nextSibling);
      } else {
        var streamShareBtn = host.querySelector ? host.querySelector("." + FILES_STREAM_SHARE_BTN_CLASS) : null;
        if (streamShareBtn) {
          host.insertBefore(newBtn, streamShareBtn.nextSibling);
        } else {
          host.insertBefore(newBtn, shareBtn.nextSibling);
        }
      }
      return true;
    }

    var iconNodes = document.querySelectorAll
      ? document.querySelectorAll("i.material-icons, span.material-icons, .material-icons")
      : [];
    for (var i = 0; i < iconNodes.length; i++) {
      var icon = iconNodes[i];
      if (!icon) continue;
      var txt = String(icon.textContent || "").trim();
      if (txt !== "share") continue;

      var shareBtn = null;
      try {
        shareBtn = icon.closest ? icon.closest("button, a") : null;
      } catch (e) {
        shareBtn = null;
      }
      if (attachToShareButton(shareBtn)) return;
    }

    var candidates = document.querySelectorAll
      ? document.querySelectorAll("button, a[href]")
      : [];
    for (var j = 0; j < candidates.length; j++) {
      var el = candidates[j];
      if (!el) continue;
      if (isInDialogOrMenu(el)) continue;
      if (!isVisible(el)) continue;

      var label = (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) || "";
      var labelLower = String(label || "").toLowerCase();
      var textLower = String(el.textContent || "").trim().toLowerCase();

      if (labelLower.indexOf("share") === -1 && textLower !== "share") continue;

      if (attachToShareButton(el)) return;
    }
  }

  // ============ SESSION LOGOUT CONTROLS ============

  var _dropprClientConfigState = { promise: null, session: null };

  function getDefaultSessionConfig() {
    return {
      admin_idle_minutes: 240,
      user_idle_minutes: 480,
      admin_max_minutes: 720,
      user_max_minutes: 1440,
      warning_seconds: 60,
    };
  }

  function clampNumber(value, min, max, fallback) {
    var n = parseIntOrNull(value);
    if (n == null) return fallback;
    if (typeof min === "number" && n < min) return min;
    if (typeof max === "number" && n > max) return max;
    return n;
  }

  function fetchClientConfig() {
    if (_dropprClientConfigState.promise) return _dropprClientConfigState.promise;

    _dropprClientConfigState.promise = fetch("/api/droppr/client-config", { method: "GET" })
      .then(function (res) {
        return res.text().then(function (text) {
          if (!res.ok) throw new Error("client-config failed: " + res.status);
          try {
            return JSON.parse(text || "{}");
          } catch (e) {
            return {};
          }
        });
      })
      .catch(function () {
        return {};
      })
      .then(function (cfg) {
        var s = cfg && cfg.session ? cfg.session : null;
        var d = getDefaultSessionConfig();
        _dropprClientConfigState.session = {
          admin_idle_minutes: clampNumber(s && s.admin_idle_minutes, 0, 525600, d.admin_idle_minutes),
          user_idle_minutes: clampNumber(s && s.user_idle_minutes, 0, 525600, d.user_idle_minutes),
          admin_max_minutes: clampNumber(s && s.admin_max_minutes, 0, 525600, d.admin_max_minutes),
          user_max_minutes: clampNumber(s && s.user_max_minutes, 0, 525600, d.user_max_minutes),
          warning_seconds: clampNumber(s && s.warning_seconds, 0, 3600, d.warning_seconds),
        };
        return _dropprClientConfigState.session;
      })
      .finally(function () {
        _dropprClientConfigState.promise = null;
      });

    return _dropprClientConfigState.promise;
  }

  function fnv1aHash(str) {
    var s = String(str || "");
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  function readStoredInt(key) {
    try {
      var v = localStorage.getItem(key);
      var n = parseIntOrNull(v);
      return n == null ? null : n;
    } catch (e) {
      return null;
    }
  }

  function writeStoredInt(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (e) {
      // ignore
    }
  }

  function clearSessionKeys() {
    try { localStorage.removeItem(SESSION_TOKEN_HASH_KEY); } catch (e) {}
    try { localStorage.removeItem(SESSION_START_MS_KEY); } catch (e2) {}
    try { localStorage.removeItem(SESSION_LAST_ACTIVITY_MS_KEY); } catch (e3) {}
    try { localStorage.removeItem(SESSION_IS_ADMIN_KEY); } catch (e4) {}
  }

  function dropprLogout(reason) {
    var token = getAuthToken();
    try {
      fetch("/api/logout", { method: "POST", headers: token ? { "X-Auth": token } : {} }).catch(function () {});
    } catch (e) {}

    clearSessionKeys();
    try { localStorage.removeItem("jwt"); } catch (e2) {}
    try { document.cookie = "auth=; Max-Age=0; path=/"; } catch (e3) {}
    try { document.cookie = "auth=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/"; } catch (e4) {}

    if (isDropprDebugEnabled()) setDebugBadge("Droppr auto-logout: " + String(reason || "timeout"));

    try {
      window.location.reload();
    } catch (e5) {
      try { window.location.href = "/"; } catch (e6) {}
    }
  }

  function ensureSessionStyles() {
    if (document.getElementById(SESSION_STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = SESSION_STYLE_ID;
    style.textContent =
      "#" + SESSION_MODAL_ID + " {\n" +
      "  position: fixed;\n" +
      "  top: 18px;\n" +
      "  left: 50%;\n" +
      "  transform: translateX(-50%);\n" +
      "  z-index: 2147483003;\n" +
      "  width: 640px;\n" +
      "  max-width: calc(100vw - 36px);\n" +
      "  border-radius: 14px;\n" +
      "  background: var(--droppr-overlay-bg, rgba(17, 24, 39, 0.98));\n" +
      "  color: var(--text-primary, #e5e7eb);\n" +
      "  border: 1px solid var(--droppr-overlay-border, rgba(255,255,255,0.12));\n" +
      "  box-shadow: 0 26px 60px -30px rgba(0,0,0,0.85);\n" +
      "  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;\n" +
      "  overflow: hidden;\n" +
      "}\n" +
      "#" + SESSION_MODAL_ID + " .row {\n" +
      "  display: flex;\n" +
      "  align-items: center;\n" +
      "  gap: 12px;\n" +
      "  padding: 14px;\n" +
      "}\n" +
      "#" + SESSION_MODAL_ID + " .icon {\n" +
      "  width: 34px;\n" +
      "  height: 34px;\n" +
      "  border-radius: 12px;\n" +
      "  display: flex;\n" +
      "  align-items: center;\n" +
      "  justify-content: center;\n" +
      "  background: rgba(245, 158, 11, 0.14);\n" +
      "  border: 1px solid rgba(245, 158, 11, 0.22);\n" +
      "  color: rgba(253, 230, 138, 0.95);\n" +
      "  flex: 0 0 auto;\n" +
      "}\n" +
      "#" + SESSION_MODAL_ID + " .txt { flex: 1 1 auto; min-width: 0; }\n" +
      "#" + SESSION_MODAL_ID + " .title { font-size: 13px; font-weight: 900; line-height: 1.15; }\n" +
      "#" + SESSION_MODAL_ID + " .status { margin-top: 4px; font-size: 12px; color: var(--droppr-overlay-muted, rgba(229,231,235,0.82)); line-height: 1.2; }\n" +
      "#" + SESSION_MODAL_ID + " .actions { display: flex; gap: 8px; flex: 0 0 auto; }\n" +
      "#" + SESSION_MODAL_ID + " .btn {\n" +
      "  cursor: pointer;\n" +
      "  border: 1px solid var(--border-color, rgba(255,255,255,0.12));\n" +
      "  background: var(--hover-bg, rgba(255,255,255,0.08));\n" +
      "  color: var(--text-primary, #fff);\n" +
      "  font-weight: 900;\n" +
      "  font-size: 12px;\n" +
      "  padding: 9px 11px;\n" +
      "  border-radius: 12px;\n" +
      "}\n" +
      "#" + SESSION_MODAL_ID + " .btn.primary { background: rgba(245, 158, 11, 0.92); border-color: rgba(255,255,255,0.0); color: #1a1200; }\n" +
      "#" + SESSION_MODAL_ID + " .btn.primary:hover { background: rgba(217, 119, 6, 0.95); }\n";
    document.head.appendChild(style);
  }

  var _sessionModalState = { shown: false, remainingSec: 0, reason: "", timer: null };

  function dismissSessionModal() {
    var existing = document.getElementById(SESSION_MODAL_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    _sessionModalState.shown = false;
    _sessionModalState.reason = "";
    _sessionModalState.remainingSec = 0;
    if (_sessionModalState.timer) {
      clearInterval(_sessionModalState.timer);
      _sessionModalState.timer = null;
    }
  }

  function showSessionModal(opts) {
    var options = opts || {};
    ensureSessionStyles();

    var existing = document.getElementById(SESSION_MODAL_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var modal = document.createElement("div");
    modal.id = SESSION_MODAL_ID;

    var row = document.createElement("div");
    row.className = "row";

    var icon = document.createElement("div");
    icon.className = "icon";
    icon.innerHTML = '<i class="material-icons">schedule</i>';

    var txt = document.createElement("div");
    txt.className = "txt";
    var title = document.createElement("div");
    title.className = "title";
    title.textContent = "Session ending soon";
    var status = document.createElement("div");
    status.className = "status";

    txt.appendChild(title);
    txt.appendChild(status);

    var actions = document.createElement("div");
    actions.className = "actions";

    var stayBtn = document.createElement("button");
    stayBtn.type = "button";
    stayBtn.className = "btn primary";
    stayBtn.textContent = "Stay signed in";

    var logoutBtn = document.createElement("button");
    logoutBtn.type = "button";
    logoutBtn.className = "btn";
    logoutBtn.textContent = "Log out";

    actions.appendChild(stayBtn);
    actions.appendChild(logoutBtn);

    row.appendChild(icon);
    row.appendChild(txt);
    row.appendChild(actions);

    modal.appendChild(row);
    document.body.appendChild(modal);

    function setText() {
      var sec = _sessionModalState.remainingSec || 0;
      var r = _sessionModalState.reason || "timeout";
      var why = r === "max" ? "security policy" : "inactivity";
      status.textContent = "Logging out in " + sec + "s due to " + why + ".";
    }

    stayBtn.addEventListener("click", function () {
      var now = nowMs();
      writeStoredInt(SESSION_LAST_ACTIVITY_MS_KEY, now);
      dismissSessionModal();
    });

    logoutBtn.addEventListener("click", function () {
      dropprLogout("manual");
    });

    setText();
    _sessionModalState.timer = setInterval(setText, 1000);
  }

  function detectIsAdmin(token) {
    if (!token) return Promise.resolve(false);
    return fetch("/api/users", { method: "GET", headers: { "X-Auth": token } })
      .then(function (res) { return !!res.ok; })
      .catch(function () { return false; });
  }

  function startSessionEnforcer() {
    if (window.__dropprSessionEnforcerBooted) return;
    window.__dropprSessionEnforcerBooted = true;

    var lastActivityWriteAt = 0;
    function noteActivity() {
      if (!isLoggedIn()) return;
      var t = nowMs();
      if (t - lastActivityWriteAt < 5000) return;
      lastActivityWriteAt = t;
      writeStoredInt(SESSION_LAST_ACTIVITY_MS_KEY, t);
    }

    ["mousemove", "mousedown", "keydown", "touchstart", "scroll"].forEach(function (evt) {
      try { window.addEventListener(evt, noteActivity, { passive: true }); } catch (e) {
        try { window.addEventListener(evt, noteActivity); } catch (e2) {}
      }
    });

    // Sync activity across tabs.
    try {
      window.addEventListener("storage", function (e) {
        if (!e) return;
        if (e.key === SESSION_LAST_ACTIVITY_MS_KEY) {
          // no-op; next tick reads latest value
        }
      });
    } catch (e3) {}

    // Ensure we have sane defaults even if config fetch fails.
    var sessionCfg = getDefaultSessionConfig();
    var lastCfgRefreshAt = 0;
    function refreshClientConfig() {
      lastCfgRefreshAt = nowMs();
      fetchClientConfig().then(function (cfg) { if (cfg) sessionCfg = cfg; });
    }
    refreshClientConfig();

    var isAdmin = null;
    var adminCheckedAt = 0;

    setInterval(function () {
      var token = getAuthToken();
      if (!token) {
        isAdmin = null;
        adminCheckedAt = 0;
        dismissSessionModal();
        return;
      }

      // Track session start per token.
      var tokenHash = fnv1aHash(token);
      var storedHash = null;
      try { storedHash = localStorage.getItem(SESSION_TOKEN_HASH_KEY); } catch (e) { storedHash = null; }
      if (storedHash !== tokenHash) {
        clearSessionKeys();
        writeStoredInt(SESSION_TOKEN_HASH_KEY, tokenHash);
        var now = nowMs();
        writeStoredInt(SESSION_START_MS_KEY, now);
        writeStoredInt(SESSION_LAST_ACTIVITY_MS_KEY, now);
        isAdmin = null;
        adminCheckedAt = 0;
      }

      var startMs = readStoredInt(SESSION_START_MS_KEY);
      var lastMs = readStoredInt(SESSION_LAST_ACTIVITY_MS_KEY);
      var nowMsVal = nowMs();
      if (startMs == null) startMs = nowMsVal;
      if (lastMs == null) lastMs = nowMsVal;

      // Refresh config occasionally (best-effort) so admin changes can propagate.
      if (nowMsVal - lastCfgRefreshAt > 5 * 60 * 1000) {
        refreshClientConfig();
      }

      // Determine admin/non-admin.
      if (isAdmin == null) {
        var storedIsAdmin = null;
        try { storedIsAdmin = localStorage.getItem(SESSION_IS_ADMIN_KEY); } catch (e2) { storedIsAdmin = null; }
        if (storedIsAdmin === "1") isAdmin = true;
        else if (storedIsAdmin === "0") isAdmin = false;
      }

      if (isAdmin == null || nowMsVal - adminCheckedAt > 15 * 60 * 1000) {
        adminCheckedAt = nowMsVal;
        detectIsAdmin(token).then(function (v) {
          isAdmin = !!v;
          try { localStorage.setItem(SESSION_IS_ADMIN_KEY, isAdmin ? "1" : "0"); } catch (e3) {}
        });
      }

      var idleMin = isAdmin ? sessionCfg.admin_idle_minutes : sessionCfg.user_idle_minutes;
      var maxMin = isAdmin ? sessionCfg.admin_max_minutes : sessionCfg.user_max_minutes;
      var warnSec = sessionCfg.warning_seconds || 0;

      var idleRemainingMs = idleMin > 0 ? (idleMin * 60000 - (nowMsVal - lastMs)) : null;
      var maxRemainingMs = maxMin > 0 ? (maxMin * 60000 - (nowMsVal - startMs)) : null;

      var remainingMs = null;
      var reason = "";
      if (idleRemainingMs != null && maxRemainingMs != null) {
        remainingMs = Math.min(idleRemainingMs, maxRemainingMs);
        reason = idleRemainingMs <= maxRemainingMs ? "idle" : "max";
      } else if (idleRemainingMs != null) {
        remainingMs = idleRemainingMs;
        reason = "idle";
      } else if (maxRemainingMs != null) {
        remainingMs = maxRemainingMs;
        reason = "max";
      } else {
        dismissSessionModal();
        return;
      }

      if (remainingMs <= 0) {
        dropprLogout(reason);
        return;
      }

      if (warnSec > 0 && remainingMs <= warnSec * 1000) {
        var sec = Math.max(1, Math.ceil(remainingMs / 1000));
        _sessionModalState.remainingSec = sec;
        _sessionModalState.reason = reason;
        if (!_sessionModalState.shown) {
          _sessionModalState.shown = true;
          showSessionModal({});
        }
      } else {
        dismissSessionModal();
      }
    }, 1000);
  }

  function boot() {
    patchUploadDetectors();
    patchFileInputs();
    ensureThemeToggle();
    startSessionEnforcer();
    ensureAnalyticsButton();
    ensureManageButton();
    ensureDropprSessionSettingsCard();
    ensureShareExpireButtons();
    ensureShareDialogStreamButtons();
    ensureFilesStreamShareButton();
    ensureFilesQuickShareButton();
    ensureRobustShareButton();
    ensureUploadRequestButton();
    startVideoMetaWatcher();
    scheduleFilesVideoHydrate();
    var observer = new MutationObserver(function () {
      ensureAnalyticsButton();
      ensureManageButton();
      ensureDropprSessionSettingsCard();
      ensureShareExpireButtons();
      ensureShareDialogStreamButtons();
      ensureFilesStreamShareButton();
      ensureFilesQuickShareButton();
      ensureRobustShareButton();
      ensureUploadRequestButton();
      scheduleFilesVideoHydrate();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    filesVideoLastPathname = String(window.location && window.location.pathname);
    setInterval(function () {
      ensureUploadRequestButton();
      if (!isFilesPage()) return;
      ensureFilesStreamShareButton();
      ensureFilesQuickShareButton();
      ensureRobustShareButton();
      var cur = String(window.location && window.location.pathname);
      if (cur !== filesVideoLastPathname) {
        filesVideoLastPathname = cur;
        scheduleFilesVideoHydrate();
      }
    }, 500);
  }

  if (document.readyState === "loading") {
    var onReady = function () {
      document.removeEventListener("DOMContentLoaded", onReady);
      boot();
    };
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    boot();
  }
})();
