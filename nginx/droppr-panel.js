(function () {
  if (window.__dropprPanelBooted) return;
  window.__dropprPanelBooted = true;

  var DROPPR_PANEL_VERSION = "21";
  var ANALYTICS_BTN_ID = "droppr-analytics-btn";
  var ANALYTICS_STYLE_ID = "droppr-analytics-style";
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

  function isSharesPage() {
    var p = String((window.location && window.location.pathname) || "");
    return p.indexOf("/settings/shares") !== -1;
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

  function showAutoShareModal(opts) {
    ensureAutoShareStyles();
    dismissAutoShareModal();

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

    var row = document.createElement("div");
    row.className = "row";

    var input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.value = opts.url || "";
    input.addEventListener("focus", function () {
      try {
        input.select();
      } catch (e) {
        // ignore
      }
    });

    var copyBtn = document.createElement("button");
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
      try {
        window.open(opts.openUrl || opts.url, "_blank", "noopener");
      } catch (e) {
        window.location.href = opts.openUrl || opts.url;
      }
    });

    row.appendChild(input);
    row.appendChild(copyBtn);
    row.appendChild(openBtn);

    body.appendChild(row);

    var note = document.createElement("div");
    note.className = "note";
    note.textContent = opts.note || "";
    if (opts.note) body.appendChild(note);

    modal.appendChild(header);
    modal.appendChild(body);
    document.body.appendChild(modal);

    try {
      input.focus();
      input.select();
    } catch (e) {
      // ignore
    }

    if (opts.autoCopy && opts.url) {
      copyText(opts.url)
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

  function boot() {
    patchUploadDetectors();
    patchFileInputs();
    ensureThemeToggle();
    ensureAnalyticsButton();
    ensureShareExpireButtons();
    startVideoMetaWatcher();
    scheduleFilesVideoHydrate();
    var observer = new MutationObserver(function () {
      ensureAnalyticsButton();
      ensureShareExpireButtons();
      scheduleFilesVideoHydrate();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    filesVideoLastPathname = String(window.location && window.location.pathname);
    setInterval(function () {
      if (!isFilesPage()) return;
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
