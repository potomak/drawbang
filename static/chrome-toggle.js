// Hamburger toggle for the shared chrome (#170). Vanilla JS, served at
// a stable URL (/chrome-toggle.js) so every surface — Vite-built or
// builder-rendered — can load the same script without a hashed bundle.

(() => {
  if (window.__drawbangChromeToggleInit) return;
  window.__drawbangChromeToggleInit = true;

  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  ready(() => {
    const toggle = document.querySelector(".chrome-menu-toggle");
    const nav = document.getElementById("chrome-nav");
    if (!(toggle instanceof HTMLButtonElement) || !nav) return;
    // The v2 header places the toggle inside the .hdr-left flex row right
    // after the logo; move it next to the nav so CSS can keep it visible
    // only on narrow viewports.

    // The chrome module emits the toggle with `hidden` so screen readers
    // see it but the visual layer hides it. CSS reveals it on narrow
    // viewports; promoting it here lets us flip aria-expanded reliably.
    toggle.hidden = false;

    const closeMenu = () => {
      if (toggle.getAttribute("aria-expanded") !== "true") return;
      toggle.setAttribute("aria-expanded", "false");
      nav.classList.remove("chrome-nav-open");
      toggle.focus();
    };

    const openMenu = () => {
      toggle.setAttribute("aria-expanded", "true");
      nav.classList.add("chrome-nav-open");
      const first = nav.querySelector("a");
      if (first instanceof HTMLAnchorElement) first.focus();
    };

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = toggle.getAttribute("aria-expanded") === "true";
      if (open) closeMenu();
      else openMenu();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMenu();
    });

    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (toggle.contains(t) || nav.contains(t)) return;
      closeMenu();
    });

    // Close on viewport widen — the nav becomes visible inline at the
    // breakpoint, so an explicit "open" state would just look weird.
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = (e) => {
      if (e.matches) {
        toggle.setAttribute("aria-expanded", "false");
        nav.classList.remove("chrome-nav-open");
      }
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
  });
})();
