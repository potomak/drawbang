// Follow-button click handler for /u/<un>, /u/<un>/followers, and
// /u/<un>/following. Read-side state (filled state + counts) is owned
// by /hydrate.js — this script only handles writes.
//
// Logged in: hide self-targeted buttons (Drawbang doesn't let you
// follow yourself); reveal the rest; optimistic toggle + POST/DELETE
// /users/<un>/follow + bump the profile-page follower counter.
//
// Logged out: reveal all buttons so the page doesn't look broken;
// click → /login?next=<current url>. The shared toggle shape lives in
// /toggle-handler.js.

(function () {
  if (typeof window === "undefined") return;
  if (typeof window.drawbangCreateToggleHandler !== "function") return;

  function viewerUsername() {
    try { return localStorage.getItem("drawbang:username") || null; } catch (e) { return null; }
  }

  function bumpProfileCounter(delta) {
    var el = document.querySelector("[data-follower-count]");
    if (!el) return;
    var n = parseInt(el.textContent || "0", 10);
    if (!Number.isFinite(n)) return;
    el.textContent = String(Math.max(0, n + delta));
  }

  window.drawbangCreateToggleHandler({
    initFlag: "__drawbangFollowInit",
    targetAttr: "data-follow-target",
    wiredAttr: "data-follow-wired",
    endpoint: function (un) { return "/users/" + encodeURIComponent(un) + "/follow"; },
    errorMessages: { press: "Could not follow", unpress: "Could not unfollow", fallback: "Follow failed" },
    onPressed: function (btn, pressed) {
      var label = btn.querySelector(".follow-label");
      if (label) label.textContent = pressed ? "Following" : "Follow";
    },
    onOptimistic: function (_btn, nextPressed) {
      bumpProfileCounter(nextPressed ? 1 : -1);
    },
    onRevert: function (_btn, nextPressed) {
      bumpProfileCounter(nextPressed ? -1 : 1);
    },
    beforeWire: function (btn) {
      var me = viewerUsername();
      var target = btn.getAttribute("data-follow-target") || "";
      // Self — leave hidden, no click handler. /hydrate.js also skips self.
      if (me && me === target) return false;
      btn.hidden = false;
      return true;
    },
  });
})();
