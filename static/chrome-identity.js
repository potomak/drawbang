// Runtime patcher for the chrome's identity link. Vanilla JS, served at a
// stable URL like /chrome-toggle.js. The editor mirrors the logged-in
// account's username to localStorage on login/logout so this script can read
// it synchronously and rewrite the link before first paint.

(() => {
  if (window.__drawbangChromeIdentityInit) return;
  window.__drawbangChromeIdentityInit = true;

  const USERNAME_KEY = "drawbang:username";

  let username = null;
  try {
    username = localStorage.getItem(USERNAME_KEY);
  } catch {
    // private-mode or disabled storage — fall through to the build-time
    // fallback href (/login), which is right for logged-out viewers.
  }
  if (!username || !/^[a-z0-9_-]{3,20}$/.test(username)) return;

  const apply = () => {
    const links = document.querySelectorAll('[data-identity-link="1"]');
    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      link.href = "/u/" + username;
      // Only rewrite the default logged-out label.
      if (link.textContent === "Sign in" || link.textContent === "Identity") {
        link.textContent = "Profile";
      }
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
})();
