// Bookmark-button wirer for feed cards (/), the drawing page (/d/<id>),
// and the bookmarks page (/u/<un>/bookmarks). Plain-JS sibling of
// /like.js with the same JWT plumbing, the same MutationObserver pickup,
// and the same data-* contract.
//
// Logged in:
//   - Collect every [data-bookmark-target] in the DOM, batch GET
//     /me/bookmarks?ids=<csv>, set aria-pressed="true" on the matches.
//   - Click → optimistic toggle (aria-pressed) + POST/DELETE
//     /drawings/<id>/bookmark. On error, revert and flash.
//
// Logged out:
//   - Click → redirect to /login?next=<current url>. No fetch fires.
//
// New cards arriving from the infinite-scroll fragment are picked up via
// a MutationObserver on document.body.

(function () {
  if (typeof window === "undefined") return;
  if (window.__drawbangBookmarkInit) return;
  window.__drawbangBookmarkInit = true;

  var JWT_KEY = "drawbang:jwt";
  var WIRED_ATTR = "data-bookmark-wired";
  var BATCH_MAX = 100;

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
      document.querySelectorAll(
        "[data-bookmark-target]:not([" + WIRED_ATTR + "])",
      ),
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

  function hydrate(buttons, t) {
    if (buttons.length === 0 || !t) return;
    var ids = [];
    var seen = {};
    for (var i = 0; i < buttons.length; i++) {
      var id = buttons[i].getAttribute("data-bookmark-target") || "";
      if (id && !seen[id]) {
        seen[id] = true;
        ids.push(id);
      }
    }
    for (var off = 0; off < ids.length; off += BATCH_MAX) {
      hydrateBookmarkedChunk(ids.slice(off, off + BATCH_MAX), t);
    }
  }

  function hydrateBookmarkedChunk(ids, t) {
    fetch("/me/bookmarks?ids=" + encodeURIComponent(ids.join(",")), {
      headers: authHeaders(t),
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.bookmarked)) return;
        var set = {};
        for (var i = 0; i < data.bookmarked.length; i++) set[data.bookmarked[i]] = true;
        var btns = document.querySelectorAll("[data-bookmark-target]");
        for (var j = 0; j < btns.length; j++) {
          var id = btns[j].getAttribute("data-bookmark-target") || "";
          if (set[id]) setPressed(btns[j], true);
        }
      })
      .catch(function () { /* network glitch — keep outline state */ });
  }

  function onClick(btn) {
    var t = token();
    if (!t) {
      var next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = "/login?next=" + next;
      return;
    }
    if (btn.disabled) return;
    btn.disabled = true;
    var drawingId = btn.getAttribute("data-bookmark-target") || "";
    var wasPressed = isPressed(btn);
    var nextPressed = !wasPressed;
    setPressed(btn, nextPressed);

    fetch("/drawings/" + encodeURIComponent(drawingId) + "/bookmark", {
      method: nextPressed ? "POST" : "DELETE",
      headers: authHeaders(t),
    })
      .then(function (res) {
        // 409 means server state already matched our optimistic outcome
        // (double-bookmark, or unbookmark-then-unbookmark). Treat as
        // success — the UI already shows the desired state.
        if (res.ok || res.status === 409) return;
        if (res.status === 401) {
          var next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = "/login?next=" + next;
          return;
        }
        return res.text().then(function (text) {
          var msg = nextPressed ? "Could not bookmark" : "Could not remove bookmark";
          try {
            var j = JSON.parse(text);
            if (j && j.error) msg = j.error;
          } catch (e) {}
          throw new Error(msg);
        });
      })
      .catch(function (e) {
        setPressed(btn, wasPressed);
        flash("error", (e && e.message) ? e.message : "Bookmark failed");
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

  function startObserver() {
    if (typeof MutationObserver !== "function") return;
    var mo = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
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
