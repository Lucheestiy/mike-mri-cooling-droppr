(function () {
  if (window.__dropprPanelBooted) return;
  window.__dropprPanelBooted = true;

  var ANALYTICS_BTN_ID = "droppr-analytics-btn";
  var ANALYTICS_STYLE_ID = "droppr-analytics-style";
  var AUTO_SHARE_STYLE_ID = "droppr-auto-share-style";
  var AUTO_SHARE_MODAL_ID = "droppr-auto-share-modal";

  var uploadBatch = null;
  var tusUploads = {};
  var lastAutoSharedPath = null;
  var lastAutoSharedAt = 0;

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

  // Validate that file is fully available (handles iCloud files still downloading)
  function validateFileReadable(file) {
    return new Promise(function (resolve) {
      // Skip validation for small files (under 1MB)
      if (file.size < 1024 * 1024) {
        resolve(true);
        return;
      }

      // Try to read first 64KB of the file to verify it's accessible
      var slice = file.slice(0, 65536);
      var reader = new FileReader();
      var timeout = null;

      function cleanup() {
        if (timeout) clearTimeout(timeout);
        reader.onload = null;
        reader.onerror = null;
      }

      reader.onload = function () {
        cleanup();
        resolve(true);
      };

      reader.onerror = function () {
        cleanup();
        resolve(false);
      };

      // Set timeout for slow iCloud downloads
      timeout = setTimeout(function () {
        cleanup();
        try { reader.abort(); } catch (e) {}
        resolve(false);
      }, 5000);

      try {
        reader.readAsArrayBuffer(slice);
      } catch (e) {
        cleanup();
        resolve(false);
      }
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

  function patchFileInputs() {
    if (window.__dropprFileInputPatched) return;
    window.__dropprFileInputPatched = true;

    // Intercept file input change events
    document.addEventListener("change", function (e) {
      var input = e.target;
      if (!input || input.type !== "file" || !input.files || input.files.length === 0) return;

      var files = Array.prototype.slice.call(input.files);
      var largeFiles = files.filter(function (f) { return f.size >= 1024 * 1024; });

      // Skip validation if no large files
      if (largeFiles.length === 0) return;

      // Check if files are readable (validates iCloud downloads are complete)
      var validationPromises = largeFiles.map(function (file) {
        return validateFileReadable(file).then(function (ok) {
          return { file: file, ok: ok };
        });
      });

      Promise.all(validationPromises).then(function (results) {
        var failed = results.filter(function (r) { return !r.ok; });
        if (failed.length > 0) {
          // Show warning for first failed file
          showFileNotReadyWarning(failed[0].file.name);
          console.warn("Droppr: File not ready for upload (possibly still downloading from iCloud):", failed[0].file.name);
        }
      });
    }, true);
  }

  function boot() {
    patchUploadDetectors();
    patchFileInputs();
    ensureAnalyticsButton();
    var observer = new MutationObserver(function () {
      ensureAnalyticsButton();
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
