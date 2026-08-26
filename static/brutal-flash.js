// Brutalist flash for /v2/* — Tailwind, 1px round, mono 11px, accent #00ffcc
// Exposes window.showBrutalFlash({kind, message, autoDismissMs}) / hideBrutalFlash
// No chrome.css, no React hydration — vanilla JS so renderToStaticMarkup pages work.
(function () {
  if (typeof window === "undefined") return;
  if (window.showBrutalFlash && window.hideBrutalFlash) return;

  var host = null;
  var timer = null;

  function ensureHost() {
    if (host) return host;
    var el = document.createElement("div");
    el.id = "brutal-flash";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("data-kind", "info");
    el.hidden = true;
    // Tailwind brutalist — 1px border, 4px round, mono, shadow
    el.className =
      "fixed left-0 right-0 top-0 z-40 flex items-center gap-3 border-b border-black bg-white px-4 py-3 font-mono text-[11px] shadow-[4px_4px_0_#0a0a0a] sm:px-6";
    el.style.borderLeft = "4px solid #0a0a0a";
    el.style.fontFamily =
      '"Departure Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    el.style.imageRendering = "pixelated";

    var msg = document.createElement("span");
    msg.id = "brutal-flash-msg";
    msg.className = "flex-1 min-w-0 break-words";
    msg.style.fontSize = "11px";
    msg.style.lineHeight = "14px";

    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    close.className =
      "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-black bg-white font-mono text-[11px] hover:bg-zinc-50";
    close.style.fontFamily =
      '"Departure Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    close.addEventListener("click", hide);

    el.appendChild(msg);
    el.appendChild(close);
    document.body.appendChild(el);
    host = el;
    return el;
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function show(opts) {
    var el = ensureHost();
    var msg = document.getElementById("brutal-flash-msg");
    clearTimer();
    var kind = opts.kind || "info";
    var message = opts.message || "";
    el.setAttribute("data-kind", kind);
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.style.borderLeft =
      kind === "success"
        ? "4px solid #00ffcc"
        : kind === "error"
          ? "4px solid #ff6060"
          : "4px solid #0a0a0a";
    msg.textContent = message;
    el.hidden = false;
    // simple slide-in
    el.style.transform = "translateY(-6px)";
    el.style.opacity = "0";
    requestAnimationFrame(function () {
      el.style.transition = "transform 140ms ease-out, opacity 140ms ease-out";
      el.style.transform = "translateY(0)";
      el.style.opacity = "1";
    });
    var ms = opts.autoDismissMs;
    if (typeof ms === "number" && isFinite(ms) && ms > 0) {
      timer = setTimeout(hide, ms);
    }
  }

  function hide() {
    clearTimer();
    if (!host) return;
    host.hidden = true;
    var msg = document.getElementById("brutal-flash-msg");
    if (msg) msg.textContent = "";
  }

  window.showBrutalFlash = show;
  window.hideBrutalFlash = hide;
  window.drawbangShowFlash = function (opts) {
    show({ kind: opts.kind, message: opts.message, autoDismissMs: opts.autoDismissMs });
  };
  window.drawbangHideFlash = hide;
})();
