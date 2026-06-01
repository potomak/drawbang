// Bookmark-button click handler for feed cards, the drawing page, and
// the bookmarks page. Read-side state (aria-pressed) is owned by
// /hydrate.js — this script only handles writes.
//
// Logged in: optimistic toggle + POST/DELETE /drawings/<id>/bookmark.
// Logged out: redirect to /login?next=<current url>.

(function () {
  if (typeof window === "undefined") return;
  if (window.__drawbangBookmarkInit) return;
  window.__drawbangBookmarkInit = true;

  var JWT_KEY = "drawbang:jwt";
  var WIRED_ATTR = "data-bookmark-wired";

  function token() {
    try { return localStorage.getItem(JWT_KEY) || null; } catch (e) { return null; }
  }

  function flash(kind, message) {
    if (typeof window.drawbangShowFlash !== "function") return;
    window.drawbangShowFlash({ kind: kind, message: message, autoDismissMs: 2400 });
  }

  function setPressed(btn, pressed) {
    btn.setAttribute("aria-pressed", pressed ? "true" : "false");
  }

  function isPressed(btn) {
    return btn.getAttribute("aria-pressed") === "true";
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
          var msg = nextPressed ? "Could not bookmark" : "Could not remove bookmark";
          try { var j = JSON.parse(text); if (j && j.error) msg = j.error; } catch (e) {}
          throw new Error(msg);
        });
      })
      .catch(function (e) {
        setPressed(btn, wasPressed);
        flash("error", (e && e.message) ? e.message : "Bookmark failed");
      })
      .then(function () { btn.disabled = false; });
  }

  function wire(btn) {
    if (btn.hasAttribute(WIRED_ATTR)) return;
    btn.setAttribute(WIRED_ATTR, "1");
    btn.addEventListener("click", function () { onClick(btn); });
  }

  function wireAll() {
    var btns = document.querySelectorAll("[data-bookmark-target]:not([" + WIRED_ATTR + "])");
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
