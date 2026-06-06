// Left-rail drawer toggle for narrow viewports. Vanilla JS, served at a
// stable URL so every surface — Vite-built or Lambda-rendered — can
// load the same script.
//
// On <860px the .rail-left is a drawer hidden off-screen
// (transform: translateX(-100%)). The .hdr-menu button (and the .hdr-logo
// when tapped on mobile) toggle it via the .is-open class. Esc, the
// backdrop scrim, and clicking outside all close it.

(() => {
  if (window.__drawbangChromeToggleInit) return;
  window.__drawbangChromeToggleInit = true;

  const MOBILE_MQ = "(max-width: 859px)";

  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  ready(() => {
    const menu = document.querySelector(".hdr-menu");
    const rail = document.getElementById("rail-left");
    const logo = document.querySelector(".hdr-logo");
    if (!(menu instanceof HTMLButtonElement) || !rail) return;
    // The chrome ships the toggle with `hidden` so screen readers see it
    // but the visual layer hides it. CSS reveals it on narrow viewports;
    // flipping hidden here lets aria-expanded stay reliable.
    menu.hidden = false;

    const mq = window.matchMedia(MOBILE_MQ);
    let scrim = null;

    const closeDrawer = () => {
      if (!rail.classList.contains("is-open")) return;
      rail.classList.remove("is-open");
      menu.setAttribute("aria-expanded", "false");
      if (scrim) {
        scrim.remove();
        scrim = null;
      }
    };

    const openDrawer = () => {
      rail.classList.add("is-open");
      menu.setAttribute("aria-expanded", "true");
      scrim = document.createElement("div");
      scrim.className = "rail-scrim";
      scrim.addEventListener("click", closeDrawer);
      document.body.appendChild(scrim);
      const first = rail.querySelector("a, button");
      if (first instanceof HTMLElement) first.focus();
    };

    const toggle = () => {
      if (rail.classList.contains("is-open")) closeDrawer();
      else openDrawer();
    };

    menu.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle();
    });

    // Logo doubles as a drawer trigger on mobile (the wall-of-text plan
    // had this — "appears only upon clicking on the logo"). On wider
    // viewports the logo behaves as a normal home link.
    if (logo instanceof HTMLAnchorElement) {
      logo.addEventListener("click", (e) => {
        if (!mq.matches) return;
        // Only intercept the first tap when the drawer is closed; the
        // second tap (drawer open) lets the link navigate home.
        if (!rail.classList.contains("is-open")) {
          e.preventDefault();
          openDrawer();
        } else {
          closeDrawer();
        }
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDrawer();
    });

    // Close on viewport widen — the drawer becomes irrelevant when the
    // rail is visible inline.
    const onChange = (e) => {
      if (!e.matches) closeDrawer();
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);

    // Close the drawer when the viewer taps a link inside it — they're
    // navigating away anyway, and leaving it open looks weird while the
    // next page loads.
    rail.addEventListener("click", (e) => {
      const t = e.target;
      if (t instanceof HTMLAnchorElement) closeDrawer();
    });
  });
})();
