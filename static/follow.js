// Follow-button wirer for the profile (/u/<un>) and the follower /
// following list pages. Plain-JS sibling of /like.js and /bookmark.js
// with the same JWT plumbing and the same data-* contract.
//
// Logged in:
//   - Hide every [data-follow-target] whose target is the viewer's own
//     username (Drawbang doesn't let you follow yourself).
//   - Reveal the remaining buttons.
//   - Batch GET /me/follows?targets=<csv>, set aria-pressed="true" on
//     the matches, label them "Following".
//   - Click → optimistic toggle (aria-pressed + label + parent profile's
//     follower count) + POST/DELETE /users/<un>/follow. On error,
//     revert and flash.
//
// Logged out:
//   - Reveal all buttons (so the page doesn't look broken) but click →
//     /login?next=<current url>. No fetch fires.

(function () {
  if (typeof window === "undefined") return;
  if (window.__drawbangFollowInit) return;
  window.__drawbangFollowInit = true;

  var JWT_KEY = "drawbang:jwt";
  var USERNAME_KEY = "drawbang:username";
  var WIRED_ATTR = "data-follow-wired";
  var BATCH_MAX = 100;

  function token() {
    try { return localStorage.getItem(JWT_KEY) || null; } catch (e) { return null; }
  }
  function viewerUsername() {
    try { return localStorage.getItem(USERNAME_KEY) || null; } catch (e) { return null; }
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
      document.querySelectorAll("[data-follow-target]:not([" + WIRED_ATTR + "])"),
    );
  }

  function markWired(btn) { btn.setAttribute(WIRED_ATTR, "1"); }
  function setPressed(btn, pressed) {
    btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    var label = btn.querySelector(".follow-label");
    if (label) label.textContent = pressed ? "Following" : "Follow";
  }
  function isPressed(btn) { return btn.getAttribute("aria-pressed") === "true"; }

  function reveal(btn) { btn.hidden = false; }

  // Adjust the profile-page header counter when the viewer follows/unfollows
  // the page's owner. Best-effort — the counters are SSR-baked and a
  // missing element just means we're not on a profile page.
  function bumpProfileCounter(selector, delta) {
    var el = document.querySelector(selector);
    if (!el) return;
    var n = parseInt(el.textContent || "0", 10);
    if (!Number.isFinite(n)) return;
    el.textContent = String(Math.max(0, n + delta));
  }

  function hydrate(buttons, t) {
    if (buttons.length === 0 || !t) return;
    var targets = [];
    var seen = {};
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].hidden) continue;
      var un = buttons[i].getAttribute("data-follow-target") || "";
      if (un && !seen[un]) { seen[un] = true; targets.push(un); }
    }
    for (var off = 0; off < targets.length; off += BATCH_MAX) {
      hydrateChunk(targets.slice(off, off + BATCH_MAX), t);
    }
  }

  function hydrateChunk(targets, t) {
    fetch("/me/follows?targets=" + encodeURIComponent(targets.join(",")), {
      headers: authHeaders(t),
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.following)) return;
        var set = {};
        for (var i = 0; i < data.following.length; i++) set[data.following[i]] = true;
        var btns = document.querySelectorAll("[data-follow-target]");
        for (var j = 0; j < btns.length; j++) {
          var un = btns[j].getAttribute("data-follow-target") || "";
          if (set[un]) setPressed(btns[j], true);
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
    var target = btn.getAttribute("data-follow-target") || "";
    var wasPressed = isPressed(btn);
    var nextPressed = !wasPressed;
    setPressed(btn, nextPressed);
    // Optimistic profile-counter bump (only fires when this button targets
    // the profile we're looking at).
    var profileMatch = document.body && document.body.dataset
      ? document.body : null;
    bumpProfileCounter('[data-follower-count]', nextPressed ? 1 : -1);

    fetch("/users/" + encodeURIComponent(target) + "/follow", {
      method: nextPressed ? "POST" : "DELETE",
      headers: authHeaders(t),
    })
      .then(function (res) {
        // 409 means server state already matched our optimistic outcome.
        if (res.ok || res.status === 409) return;
        if (res.status === 401) {
          var next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = "/login?next=" + next;
          return;
        }
        return res.text().then(function (text) {
          var msg = nextPressed ? "Could not follow" : "Could not unfollow";
          try {
            var j = JSON.parse(text);
            if (j && j.error) msg = j.error;
          } catch (e) {}
          throw new Error(msg);
        });
      })
      .catch(function (e) {
        setPressed(btn, wasPressed);
        bumpProfileCounter('[data-follower-count]', nextPressed ? -1 : 1);
        flash("error", (e && e.message) ? e.message : "Follow failed");
        // Mute the unused-var warning for profileMatch; the field exists
        // so future extensions (per-card counter bumps) can hang off it.
        void profileMatch;
      })
      .then(function () { btn.disabled = false; });
  }

  function wire(btn) {
    if (btn.hasAttribute(WIRED_ATTR)) return;
    markWired(btn);
    var me = viewerUsername();
    var target = btn.getAttribute("data-follow-target") || "";
    if (me && me === target) {
      // Viewer is looking at themselves — Drawbang doesn't let you
      // follow yourself, so leave the button hidden and skip wiring.
      return;
    }
    reveal(btn);
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
        if (mutations[i].addedNodes.length > 0) { wireAll(); return; }
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
