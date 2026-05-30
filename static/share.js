// Shared Web Share wirer for `[data-share-button]` controls. The button
// declares the target as a path (e.g. `/d/<id>`) via data-share-target;
// the wirer resolves it against the current origin so the URL surfaces
// fully-qualified to the share sheet.
//
//   data-share-button         marker attribute, value ignored
//   data-share-target         the URL or absolute path to share
//   data-share-title          optional title/text (defaults to "Pixel art
//                             from Draw!")
//
// On click: tries navigator.share with Web Share API; on any failure or
// no-support, falls back to copying the URL via the Clipboard API (or a
// textarea-execCommand shim on browsers that gate clipboard writes) and
// raises a flash. AbortError (user-dismissed sheet) is silent.

(function () {
  if (typeof window === "undefined") return;
  if (window.__drawbangShareInit) return;
  window.__drawbangShareInit = true;

  var WIRED_ATTR = "data-share-wired";

  function flash(kind, message) {
    if (typeof window.drawbangShowFlash !== "function") return;
    window.drawbangShowFlash({ kind: kind, message: message, autoDismissMs: 1800 });
  }

  function fallbackCopy(url) {
    var tmp = document.createElement("textarea");
    tmp.value = url;
    tmp.setAttribute("readonly", "");
    tmp.style.position = "fixed";
    tmp.style.top = "-9999px";
    document.body.appendChild(tmp);
    tmp.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(tmp);
    return ok;
  }

  function copy(url) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(url);
    }
    return fallbackCopy(url) ? Promise.resolve() : Promise.reject(new Error("copy failed"));
  }

  function resolveUrl(target) {
    if (!target) return window.location.href;
    if (/^https?:\/\//i.test(target)) return target;
    return new URL(target, window.location.origin).href;
  }

  function wire(btn) {
    if (btn.hasAttribute(WIRED_ATTR)) return;
    btn.setAttribute(WIRED_ATTR, "1");
    btn.addEventListener("click", async function () {
      var url = resolveUrl(btn.getAttribute("data-share-target"));
      var title = btn.getAttribute("data-share-title") || "Pixel art from Draw!";
      var payload = { title: title, text: title, url: url };

      var canWebShare =
        typeof navigator !== "undefined" &&
        typeof navigator.share === "function" &&
        (typeof navigator.canShare !== "function" || navigator.canShare(payload));

      if (canWebShare) {
        try {
          await navigator.share(payload);
          return;
        } catch (e) {
          if (e && e.name === "AbortError") return;
          // Fall through to copy.
        }
      }

      try {
        await copy(url);
        flash("success", "Link copied");
      } catch (e) {
        flash("error", "Could not share — try long-pressing the URL");
      }
    });
  }

  function wireAll() {
    var btns = document.querySelectorAll("[data-share-button]:not([" + WIRED_ATTR + "])");
    for (var i = 0; i < btns.length; i++) wire(btns[i]);
  }

  function init() {
    wireAll();
    if (typeof MutationObserver === "function") {
      var mo = new MutationObserver(function () { wireAll(); });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
