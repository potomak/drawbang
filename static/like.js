// Heart-button wirer for feed cards (/) and the drawing page (/d/<id>).
// Plain-JS sibling of /tile-page.js. Reads localStorage["drawbang:jwt"]
// the same way; relies on /flash.js for error recovery messaging.
//
// Logged in:
//   - Collect every [data-like-target] in the DOM, batch GET
//     /me/likes?ids=<csv>, set aria-pressed="true" on the matches.
//   - Click → optimistic toggle (aria-pressed + count text) + POST/DELETE
//     /drawings/<id>/like. On error, revert and flash.
//
// Logged out:
//   - Click → redirect to /login?next=<current url>. No fetch fires.
//
// New cards arriving from the infinite-scroll fragment are picked up via
// a MutationObserver on document.body — no coupling to the feed observer.

(function () {
  if (typeof window === "undefined") return;
  if (window.__drawbangLikeInit) return;
  window.__drawbangLikeInit = true;

  var JWT_KEY = "drawbang:jwt";
  var WIRED_ATTR = "data-like-wired";
  var BATCH_MAX = 100; // matches DynamoDB BatchGetItem cap

  function token() {
    try {
      return localStorage.getItem(JWT_KEY) || null;
    } catch (e) {
      return null;
    }
  }

  function flash(kind, message) {
    if (typeof window.drawbangShowFlash !== "function") return;
    window.drawbangShowFlash({ kind: kind, message: message, autoDismissMs: 2400 });
  }

  function authHeaders(t) {
    return { Authorization: "Bearer " + t };
  }

  function unwiredButtons() {
    return Array.prototype.slice.call(
      document.querySelectorAll("[data-like-target]:not([" + WIRED_ATTR + "])"),
    );
  }

  function markWired(btn) {
    btn.setAttribute(WIRED_ATTR, "1");
  }

  function setPressed(btn, pressed) {
    btn.setAttribute("aria-pressed", pressed ? "true" : "false");
  }

  function isPressed(btn) {
    return btn.getAttribute("aria-pressed") === "true";
  }

  function countEl(btn) {
    return btn.querySelector("[data-like-count]");
  }

  function readCount(btn) {
    var el = countEl(btn);
    if (!el) return 0;
    var n = parseInt(el.textContent || "0", 10);
    return Number.isFinite(n) ? n : 0;
  }

  function writeCount(btn, n) {
    var el = countEl(btn);
    if (el) el.textContent = String(Math.max(0, n));
  }

  // -- Hydrate filled state + fresh counts -----------------------------------
  // The SSR count is baked into edge-cached HTML and goes stale (up to
  // the home page's s-maxage). Every page load fetches fresh counts from
  // /likes/counts (public, short-cache) and rewrites the <span
  // data-like-count> text so a liker who bumped the count anywhere sees
  // the truth on next visit. Logged-in users additionally hit /me/likes
  // (per-user, no-store) for the filled state.
  function hydrate(buttons, t) {
    if (buttons.length === 0) return;
    var ids = [];
    var seen = {};
    for (var i = 0; i < buttons.length; i++) {
      var id = buttons[i].getAttribute("data-like-target") || "";
      if (id && !seen[id]) {
        seen[id] = true;
        ids.push(id);
      }
    }
    for (var off = 0; off < ids.length; off += BATCH_MAX) {
      var chunk = ids.slice(off, off + BATCH_MAX);
      hydrateCountsChunk(chunk);
      if (t) hydrateLikedChunk(chunk, t);
    }
  }

  function hydrateCountsChunk(ids) {
    fetch("/likes/counts?ids=" + encodeURIComponent(ids.join(",")))
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.counts) return;
        for (var id in data.counts) {
          if (!Object.prototype.hasOwnProperty.call(data.counts, id)) continue;
          var n = data.counts[id];
          if (typeof n !== "number") continue;
          var btns = document.querySelectorAll('[data-like-target="' + id + '"]');
          for (var j = 0; j < btns.length; j++) writeCount(btns[j], n);
        }
      })
      .catch(function () { /* network glitch — keep SSR'd values */ });
  }

  function hydrateLikedChunk(ids, t) {
    fetch("/me/likes?ids=" + encodeURIComponent(ids.join(",")), {
      headers: authHeaders(t),
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.liked)) return;
        var likedSet = {};
        for (var i = 0; i < data.liked.length; i++) likedSet[data.liked[i]] = true;
        var btns = document.querySelectorAll("[data-like-target]");
        for (var j = 0; j < btns.length; j++) {
          var id = btns[j].getAttribute("data-like-target") || "";
          if (likedSet[id]) setPressed(btns[j], true);
        }
      })
      .catch(function () { /* network glitch — keep outline state */ });
  }

  // -- Click handler ----------------------------------------------------------
  function onClick(btn) {
    var t = token();
    if (!t) {
      var next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = "/login?next=" + next;
      return;
    }
    if (btn.disabled) return;
    btn.disabled = true;
    var drawingId = btn.getAttribute("data-like-target") || "";
    var wasPressed = isPressed(btn);
    var prevCount = readCount(btn);
    var nextPressed = !wasPressed;
    var nextCount = wasPressed ? Math.max(0, prevCount - 1) : prevCount + 1;
    setPressed(btn, nextPressed);
    writeCount(btn, nextCount);

    fetch("/drawings/" + encodeURIComponent(drawingId) + "/like", {
      method: nextPressed ? "POST" : "DELETE",
      headers: authHeaders(t),
    })
      .then(function (res) {
        // 409 means the server's state already matched our optimistic
        // outcome (double-like, or unlike-then-unlike). Treat as success
        // — the UI already shows the desired state.
        if (res.ok || res.status === 409) return;
        if (res.status === 401) {
          var next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = "/login?next=" + next;
          return;
        }
        return res.text().then(function (text) {
          var msg = nextPressed ? "Could not like" : "Could not unlike";
          try {
            var j = JSON.parse(text);
            if (j && j.error) msg = j.error;
          } catch (e) {}
          throw new Error(msg);
        });
      })
      .catch(function (e) {
        setPressed(btn, wasPressed);
        writeCount(btn, prevCount);
        flash("error", (e && e.message) ? e.message : "Like failed");
      })
      .then(function () {
        btn.disabled = false;
      });
  }

  function wire(btn) {
    if (btn.hasAttribute(WIRED_ATTR)) return;
    markWired(btn);
    btn.addEventListener("click", function () { onClick(btn); });
  }

  function wireAll() {
    var btns = unwiredButtons();
    if (btns.length === 0) return;
    for (var i = 0; i < btns.length; i++) wire(btns[i]);
    hydrate(btns, token());
  }

  // -- Re-wire on DOM growth (infinite-scroll appends) ------------------------
  function startObserver() {
    if (typeof MutationObserver !== "function") return;
    var mo = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
          // Debounce: any insertion triggers one pass.
          wireAll();
          return;
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    wireAll();
    startObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
