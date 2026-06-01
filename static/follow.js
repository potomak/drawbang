// Follow-button click handler for /u/<un>, /u/<un>/followers, and
// /u/<un>/following. Read-side state (filled state + counts) is owned
// by /hydrate.js — this script only handles writes.
//
// Logged in:
//   - Hide self-targeted buttons (Drawbang doesn't let you follow
//     yourself); reveal the rest.
//   - Click → optimistic toggle + POST/DELETE /users/<un>/follow + bump
//     the profile-page follower counter.
//
// Logged out:
//   - Reveal all buttons so the page doesn't look broken.
//   - Click → /login?next=<current url>. No fetch fires.

(function () {
  if (typeof window === "undefined") return;
  if (window.__drawbangFollowInit) return;
  window.__drawbangFollowInit = true;

  var JWT_KEY = "drawbang:jwt";
  var USERNAME_KEY = "drawbang:username";
  var WIRED_ATTR = "data-follow-wired";

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

  function setPressed(btn, pressed) {
    btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    var label = btn.querySelector(".follow-label");
    if (label) label.textContent = pressed ? "Following" : "Follow";
  }
  function isPressed(btn) {
    return btn.getAttribute("aria-pressed") === "true";
  }

  function bumpProfileCounter(selector, delta) {
    var el = document.querySelector(selector);
    if (!el) return;
    var n = parseInt(el.textContent || "0", 10);
    if (!Number.isFinite(n)) return;
    el.textContent = String(Math.max(0, n + delta));
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
    bumpProfileCounter('[data-follower-count]', nextPressed ? 1 : -1);

    fetch("/users/" + encodeURIComponent(target) + "/follow", {
      method: nextPressed ? "POST" : "DELETE",
      headers: { Authorization: "Bearer " + t },
    })
      .then(function (res) {
        if (res.ok || res.status === 409) return;
        if (res.status === 401) {
          var n = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = "/login?next=" + n;
          return;
        }
        return res.text().then(function (text) {
          var msg = nextPressed ? "Could not follow" : "Could not unfollow";
          try { var j = JSON.parse(text); if (j && j.error) msg = j.error; } catch (e) {}
          throw new Error(msg);
        });
      })
      .catch(function (e) {
        setPressed(btn, wasPressed);
        bumpProfileCounter('[data-follower-count]', nextPressed ? -1 : 1);
        flash("error", (e && e.message) ? e.message : "Follow failed");
      })
      .then(function () { btn.disabled = false; });
  }

  function wire(btn) {
    if (btn.hasAttribute(WIRED_ATTR)) return;
    btn.setAttribute(WIRED_ATTR, "1");
    var me = viewerUsername();
    var target = btn.getAttribute("data-follow-target") || "";
    if (me && me === target) {
      // Self — leave hidden, no click handler. /hydrate.js also skips self.
      return;
    }
    btn.hidden = false;
    btn.addEventListener("click", function () { onClick(btn); });
  }

  function wireAll() {
    var btns = document.querySelectorAll("[data-follow-target]:not([" + WIRED_ATTR + "])");
    for (var i = 0; i < btns.length; i++) wire(btns[i]);
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

  function init() { wireAll(); startObserver(); }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
