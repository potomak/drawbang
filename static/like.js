// Heart-button click handler for feed cards (/) and the drawing page
// (/d/<id>). Read-side state (filled state + counts) is owned by
// /hydrate.js — this script only handles writes. The shared toggle
// shape lives in /toggle-handler.js.

(function () {
  if (typeof window === "undefined") return;
  if (typeof window.drawbangCreateToggleHandler !== "function") return;

  function countEl(btn) { return btn.querySelector("[data-like-count]"); }
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

  // Snapshot the pre-click count so revert restores it exactly even
  // after a clamped decrement.
  var prevCounts = new WeakMap();

  window.drawbangCreateToggleHandler({
    initFlag: "__drawbangLikeInit",
    targetAttr: "data-like-target",
    wiredAttr: "data-like-wired",
    endpoint: function (id) { return "/drawings/" + encodeURIComponent(id) + "/like"; },
    errorMessages: { press: "Could not like", unpress: "Could not unlike", fallback: "Like failed" },
    onOptimistic: function (btn, nextPressed) {
      var prev = readCount(btn);
      prevCounts.set(btn, prev);
      writeCount(btn, nextPressed ? prev + 1 : prev - 1);
    },
    onRevert: function (btn) {
      var prev = prevCounts.get(btn);
      if (typeof prev === "number") writeCount(btn, prev);
    },
  });
})();
