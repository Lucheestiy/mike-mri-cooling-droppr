(function () {
  if (window.__dropprPanelBooted) return;
  window.__dropprPanelBooted = true;

  var ANALYTICS_BTN_ID = "droppr-analytics-btn";
  var ANALYTICS_STYLE_ID = "droppr-analytics-style";
  var SHARE_EXPIRE_STYLE_ID = "droppr-share-expire-style";
  var SHARE_EXPIRE_BTN_CLASS = "droppr-share-expire-btn";
  var SHARE_EXPIRE_STORAGE_KEY = "droppr_share_expire_hours";
  var AUTO_SHARE_STYLE_ID = "droppr-auto-share-style";
  var AUTO_SHARE_MODAL_ID = "droppr-auto-share-modal";
  var ICLOUD_WAIT_STYLE_ID = "droppr-icloud-wait-style";
  var ICLOUD_WAIT_MODAL_ID = "droppr-icloud-wait";

  var uploadBatch = null;
  var tusUploads = {};
  var lastAutoSharedPath = null;
  var lastAutoSharedAt = 0;
  var fileInputBypass = false;
  var fileInputGate = null;

  function nowMs() {
    return new Date().getTime();
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
      "  background: rgba(17, 24, 39, 0.98);\n" +
      "  color: #e5e7eb;\n" +
      "  border: 1px solid rgba(255,255,255,0.12);\n" +
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
      "  color: #fff;\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .subtitle {\n" +
      "  font-size: 12px;\n" +
      "  line-height: 1.2;\n" +
      "  margin-top: 4px;\n" +
      "  color: rgba(229,231,235,0.8);\n" +
      "  word-break: break-word;\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .close {\n" +
      "  appearance: none;\n" +
      "  border: 0;\n" +
      "  background: transparent;\n" +
      "  color: rgba(229,231,235,0.85);\n" +
      "  cursor: pointer;\n" +
      "  font-size: 18px;\n" +
      "  line-height: 1;\n" +
      "  padding: 6px 8px;\n" +
      "  border-radius: 10px;\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .close:hover {\n" +
      "  background: rgba(255,255,255,0.08);\n" +
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
      "  border: 1px solid rgba(255,255,255,0.12);\n" +
      "  background: rgba(0,0,0,0.22);\n" +
      "  padding: 10px 10px;\n" +
      "  color: #fff;\n" +
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
      "  border: 1px solid rgba(255,255,255,0.12);\n" +
      "  background: rgba(99, 102, 241, 0.95);\n" +
      "  color: #fff;\n" +
      "  font-weight: 800;\n" +
      "  font-size: 13px;\n" +
      "  padding: 10px 12px;\n" +
      "  border-radius: 10px;\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .btn.secondary {\n" +
      "  background: rgba(255,255,255,0.08);\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .btn:hover {\n" +
      "  filter: brightness(1.05);\n" +
      "}\n" +
      "#" + AUTO_SHARE_MODAL_ID + " .note {\n" +
      "  margin-top: 10px;\n" +
      "  font-size: 12px;\n" +
      "  color: rgba(229,231,235,0.72);\n" +
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
      "  background: rgba(17, 24, 39, 0.98);\n" +
      "  color: #e5e7eb;\n" +
      "  border: 1px solid rgba(255,255,255,0.12);\n" +
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
      "  border: 2px solid rgba(255,255,255,0.25);\n" +
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
      "  color: #fff;\n" +
      "  line-height: 1.15;\n" +
      "}\n" +
      "#" + ICLOUD_WAIT_MODAL_ID + " .status {\n" +
      "  margin-top: 4px;\n" +
      "  font-size: 12px;\n" +
      "  color: rgba(229,231,235,0.82);\n" +
      "  word-break: break-word;\n" +
      "  line-height: 1.2;\n" +
      "}\n" +
      "#" + ICLOUD_WAIT_MODAL_ID + " .note {\n" +
      "  margin-top: 6px;\n" +
      "  font-size: 12px;\n" +
      "  color: rgba(229,231,235,0.65);\n" +
      "}\n" +
      "#" + ICLOUD_WAIT_MODAL_ID + " .btn {\n" +
      "  flex: 0 0 auto;\n" +
      "  cursor: pointer;\n" +
      "  border: 1px solid rgba(255,255,255,0.12);\n" +
      "  background: rgba(255,255,255,0.08);\n" +
      "  color: #fff;\n" +
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
    ensureAnalyticsButton();
    ensureShareExpireButtons();
    var observer = new MutationObserver(function () {
      ensureAnalyticsButton();
      ensureShareExpireButtons();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
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
