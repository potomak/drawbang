// Runtime patcher for the chrome's identity link (#171). Vanilla JS,
// served at a stable URL like /chrome-toggle.js. Identity is held in
// IndexedDB by the editor; we mirror the pubkey to localStorage on
// every save/load so this script can read it synchronously and
// rewrite the link before first paint.

(() => {
  if (window.__drawbangChromeIdentityInit) return;
  window.__drawbangChromeIdentityInit = true;

  const MIRROR_KEY = "drawbang:pubkey";

  let pubkey = null;
  try {
    pubkey = localStorage.getItem(MIRROR_KEY);
  } catch {
    // private-mode or disabled storage — fall through to the build-time
    // fallback href, which is the right behaviour for anonymous viewers.
  }
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) return;

  const apply = () => {
    const links = document.querySelectorAll('[data-identity-link="1"]');
    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      link.href = "/keys/" + pubkey;
      // Only rewrite the label if it's still the default; the editor's
      // identity-aware UX may have customised it.
      if (link.textContent === "identity") link.textContent = "profile";
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
})();
