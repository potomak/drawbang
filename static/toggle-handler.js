// Shared factory for the like / bookmark / follow click handlers.
// Each consumer ships ~125 lines of nearly identical vanilla JS — JWT
// guard, isPressed/setPressed, optimistic toggle + revert-on-error,
// MutationObserver re-wiring for infinite scroll, 401 → /login?next=
// redirect. This module owns that shape; the consumers pass config.
//
// Read-side state (counts, filled state) is still owned by /hydrate.js
// — toggle handlers only fire writes.

(function () {
  if (typeof window === "undefined") return;
  if (window.drawbangCreateToggleHandler) return;

  var JWT_KEY = "drawbang:jwt";

  function token() {
    try { return localStorage.getItem(JWT_KEY) || null; } catch (e) { return null; }
  }

  function flash(kind, message) {
    if (typeof window.drawbangShowFlash !== "function") return;
    window.drawbangShowFlash({ kind: kind, message: message, autoDismissMs: 2400 });
  }

  function redirectToLogin() {
    var next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = "/login?next=" + next;
  }

  function isPressed(btn) {
    return btn.getAttribute("aria-pressed") === "true";
  }

  // config:
  //   initFlag       — `window[initFlag]` guard against double init
  //   targetAttr     — e.g. "data-like-target"; its value is passed to endpoint()
  //   wiredAttr      — e.g. "data-like-wired"; marker so we wire each btn once
  //   endpoint(t)    — returns the URL for POST/DELETE
  //   errorMessages  — { press, unpress, fallback }
  //   onPressed(btn, pressed)      — optional extra render after aria-pressed
  //   onOptimistic(btn, next, was) — optional extra optimistic side effect
  //   onRevert(btn, next, was)     — optional revert for the onOptimistic side effect
  //   onSuccess(btn, next, was)    — optional; fires only once the server confirms the write
  //   beforeWire(btn)              — optional; return false to skip wiring (e.g. self-follow)
  window.drawbangCreateToggleHandler = function (config) {
    if (window[config.initFlag]) return;
    window[config.initFlag] = true;

    function setPressed(btn, pressed) {
      btn.setAttribute("aria-pressed", pressed ? "true" : "false");
      if (config.onPressed) config.onPressed(btn, pressed);
    }

    function onClick(btn) {
      var t = token();
      if (!t) { redirectToLogin(); return; }
      if (btn.disabled) return;
      btn.disabled = true;
      var target = btn.getAttribute(config.targetAttr) || "";
      var wasPressed = isPressed(btn);
      var nextPressed = !wasPressed;
      setPressed(btn, nextPressed);
      if (config.onOptimistic) config.onOptimistic(btn, nextPressed, wasPressed);

      fetch(config.endpoint(target), {
        method: nextPressed ? "POST" : "DELETE",
        headers: { Authorization: "Bearer " + t },
      })
        .then(function (res) {
          // 409 means the server's state already matched our optimistic
          // outcome — treat as success.
          if (res.ok || res.status === 409) {
            if (config.onSuccess) config.onSuccess(btn, nextPressed, wasPressed);
            return;
          }
          if (res.status === 401) { redirectToLogin(); return; }
          return res.text().then(function (text) {
            var msg = nextPressed ? config.errorMessages.press : config.errorMessages.unpress;
            try { var j = JSON.parse(text); if (j && j.error) msg = j.error; } catch (e) {}
            throw new Error(msg);
          });
        })
        .catch(function (e) {
          setPressed(btn, wasPressed);
          if (config.onRevert) config.onRevert(btn, nextPressed, wasPressed);
          flash("error", (e && e.message) ? e.message : config.errorMessages.fallback);
        })
        .then(function () { btn.disabled = false; });
    }

    function wire(btn) {
      if (btn.hasAttribute(config.wiredAttr)) return;
      btn.setAttribute(config.wiredAttr, "1");
      if (config.beforeWire && config.beforeWire(btn) === false) return;
      btn.addEventListener("click", function () { onClick(btn); });
    }

    function wireAll() {
      var sel = "[" + config.targetAttr + "]:not([" + config.wiredAttr + "])";
      var btns = document.querySelectorAll(sel);
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
  };
})();
