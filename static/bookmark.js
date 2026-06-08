// Bookmark-button click handler for feed cards, the drawing page, and
// the bookmarks page. Read-side state (aria-pressed) is owned by
// /hydrate.js — this script only handles writes. The shared toggle
// shape lives in /toggle-handler.js.

(function () {
  if (typeof window === "undefined") return;
  if (typeof window.drawbangCreateToggleHandler !== "function") return;

  window.drawbangCreateToggleHandler({
    initFlag: "__drawbangBookmarkInit",
    targetAttr: "data-bookmark-target",
    wiredAttr: "data-bookmark-wired",
    endpoint: function (id) { return "/drawings/" + encodeURIComponent(id) + "/bookmark"; },
    errorMessages: {
      press: "Could not bookmark",
      unpress: "Could not remove bookmark",
      fallback: "Bookmark failed",
    },
  });
})();
