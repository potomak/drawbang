// Plain-JS port of src/layout/flash.ts so builder-rendered pages (which
// don't ship a Vite bundle) can use the same flash UI as the Vite-served
// surfaces. Loaded via <script src="/flash.js"> and exposes:
//
//   window.drawbangShowFlash({ kind, message, action?, autoDismissMs? })
//   window.drawbangHideFlash()
//
// Styles live in chrome.css (which every surface already imports), keyed
// off the .flash / .flash-body / .flash-msg / .flash-action / .flash-close
// classes. The DOM shape constructed here MUST match what flash.ts builds
// so a single stylesheet covers both implementations.
//
// Keep this file in lockstep with src/layout/flash.ts. CLAUDE.md ("UI/UX
// consistency") flags the lift-don't-fork rule.

(function () {
  if (typeof window === "undefined") return;
  if (window.drawbangShowFlash && window.drawbangHideFlash) return; // idempotent

  var host = null;
  var msgSlot = null;
  var actionSlot = null;
  var timer = null;

  function ensureHost() {
    if (host) return host;
    var el = document.createElement("div");
    el.className = "flash";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("data-kind", "info");
    el.hidden = true;

    var body = document.createElement("div");
    body.className = "flash-body";

    var msg = document.createElement("span");
    msg.className = "flash-msg";

    var action = document.createElement("a");
    action.className = "flash-action";
    action.target = "_blank";
    action.rel = "noopener";
    action.hidden = true;

    body.appendChild(msg);
    body.appendChild(action);

    var close = document.createElement("button");
    close.type = "button";
    close.className = "flash-close";
    close.setAttribute("aria-label", "Dismiss message");
    close.textContent = "×";
    close.addEventListener("click", function () { hideFlash(); });

    el.appendChild(body);
    el.appendChild(close);

    el.addEventListener("mouseenter", pauseTimer);
    el.addEventListener("mouseleave", resumeTimer);
    el.addEventListener("focusin", pauseTimer);
    el.addEventListener("focusout", resumeTimer);

    document.body.appendChild(el);
    host = el;
    msgSlot = msg;
    actionSlot = action;
    return el;
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer.handle);
      timer = null;
    }
  }

  function pauseTimer() {
    if (!timer || timer.startedAt === 0) return;
    var elapsed = Date.now() - timer.startedAt;
    var remaining = Math.max(0, timer.remainingMs - elapsed);
    clearTimeout(timer.handle);
    timer = { remainingMs: remaining, startedAt: 0, handle: 0 };
  }

  function resumeTimer() {
    if (!timer || timer.startedAt !== 0) return;
    var remaining = timer.remainingMs;
    if (remaining <= 0) {
      timer = null;
      hideFlash();
      return;
    }
    timer = {
      remainingMs: remaining,
      startedAt: Date.now(),
      handle: setTimeout(function () { hideFlash(); }, remaining),
    };
  }

  function showFlash(opts) {
    var el = ensureHost();
    var msg = msgSlot;
    var action = actionSlot;

    clearTimer();

    el.setAttribute("data-kind", opts.kind);
    el.setAttribute("role", opts.kind === "error" ? "alert" : "status");

    var children;
    if (Array.isArray(opts.message)) {
      children = opts.message.slice();
    } else {
      children = [opts.message];
    }
    var nodes = [];
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      nodes.push(typeof c === "string" ? document.createTextNode(c) : c);
    }
    msg.replaceChildren.apply(msg, nodes);

    if (opts.action) {
      action.textContent = opts.action.label;
      action.href = opts.action.href;
      action.hidden = false;
    } else {
      action.hidden = true;
      action.removeAttribute("href");
      action.textContent = "";
    }

    var wasHidden = el.hidden;
    el.hidden = false;
    if (wasHidden) {
      el.style.animation = "none";
      // eslint-disable-next-line no-unused-expressions
      el.offsetHeight; // reflow → restart keyframe
      el.style.animation = "";
    }

    var ms = opts.autoDismissMs;
    if (typeof ms === "number" && isFinite(ms) && ms > 0) {
      timer = {
        remainingMs: ms,
        startedAt: Date.now(),
        handle: setTimeout(function () { hideFlash(); }, ms),
      };
    }
  }

  function hideFlash() {
    clearTimer();
    if (!host) return;
    host.hidden = true;
    if (msgSlot) msgSlot.replaceChildren();
    if (actionSlot) {
      actionSlot.hidden = true;
      actionSlot.removeAttribute("href");
      actionSlot.textContent = "";
    }
  }

  window.drawbangShowFlash = showFlash;
  window.drawbangHideFlash = hideFlash;

  // Pending-flash consumer: pages that queue a flash with sessionStorage
  // ["drawbang:pending-flash"] (set via src/layout/flash.ts setPendingFlash)
  // get it surfaced on the next page load. One-shot — read+remove, race-safe
  // because removeItem is atomic. JSON-only, so messages are strings here.
  try {
    var raw = sessionStorage.getItem("drawbang:pending-flash");
    if (raw) {
      sessionStorage.removeItem("drawbang:pending-flash");
      var pending = JSON.parse(raw);
      if (pending && typeof pending.kind === "string" && typeof pending.message === "string") {
        var fire = function () { showFlash(pending); };
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", fire, { once: true });
        } else {
          fire();
        }
      }
    }
  } catch (_e) {
    // private mode / malformed JSON — ignore.
  }
})();
