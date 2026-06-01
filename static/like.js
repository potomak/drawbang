// Heart-button click handler for feed cards (/) and the drawing page
// (/d/<id>). Read-side state (filled state + counts) is owned by
// /hydrate.js — this script only handles writes.
//
// Logged in: optimistic toggle + POST/DELETE /drawings/<id>/like. On
//   error revert and flash.
// Logged out: click → /login?next=<current url>. No fetch fires.
//
// MutationObserver re-wires newly-appended cards (infinite scroll).

(function () {
  if (typeof window === "undefined") return;
  if (window.__drawbangLikeInit) return;
  window.__drawbangLikeInit = true;

  var JWT_KEY = "drawbang:jwt";
  var WIRED_ATTR = "data-like-wired";

  function token() {
    try { return localStorage.getItem(JWT_KEY) || null; } catch (e) { return null; }
  }

  function flash(kind, message) {
    if (typeof window.drawbangShowFlash !== "function") return;
    window.drawbangShowFlash({ kind: kind, message: message, autoDismissMs: 2400 });
  }

  function isPressed(btn) {
    return btn.getAttribute("aria-pressed") === "true";
  }

  function setPressed(btn, pressed) {
    btn.setAttribute("aria-pressed", pressed ? "true" : "false");
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
      headers: { Authorization: "Bearer " + t },
    })
      .then(function (res) {
        // 409 means the server's state already matched our optimistic
        // outcome — treat as success.
        if (res.ok || res.status === 409) return;
        if (res.status === 401) {
          var n = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = "/login?next=" + n;
          return;
        }
        return res.text().then(function (text) {
          var msg = nextPressed ? "Could not like" : "Could not unlike";
          try { var j = JSON.parse(text); if (j && j.error) msg = j.error; } catch (e) {}
          throw new Error(msg);
        });
      })
      .catch(function (e) {
        setPressed(btn, wasPressed);
        writeCount(btn, prevCount);
        flash("error", (e && e.message) ? e.message : "Like failed");
      })
      .then(function () { btn.disabled = false; });
  }

  function wire(btn) {
    if (btn.hasAttribute(WIRED_ATTR)) return;
    btn.setAttribute(WIRED_ATTR, "1");
    btn.addEventListener("click", function () { onClick(btn); });
  }

  function wireAll() {
    var btns = document.querySelectorAll("[data-like-target]:not([" + WIRED_ATTR + "])");
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
