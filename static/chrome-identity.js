// Runtime patcher for the chrome's identity link. Vanilla JS, served at a
// stable URL like /chrome-toggle.js. The editor mirrors the logged-in
// account's username to localStorage on login/logout so this script can read
// it synchronously and rewrite the link before first paint.

(() => {
  if (window.__drawbangChromeIdentityInit) return;
  window.__drawbangChromeIdentityInit = true;

  const USERNAME_KEY = "drawbang:username";
  const JWT_KEY = "drawbang:jwt";

  let username = null;
  try {
    username = localStorage.getItem(USERNAME_KEY);
  } catch {
    // private-mode or disabled storage — fall through to the build-time
    // fallback href (/login), which is right for logged-out viewers.
  }
  if (!username || !/^[a-z0-9_-]{3,20}$/.test(username)) return;

  const logout = (e) => {
    e.preventDefault();
    try {
      localStorage.removeItem(JWT_KEY);
      localStorage.removeItem(USERNAME_KEY);
    } catch {
      // ignore storage errors — worst case the next page load still sees a
      // session, but the JWT removal above almost always succeeds.
    }
    // Queue a flash so the destination page can surface it after the redirect.
    // /flash.js (loaded by the chrome footer) consumes drawbang:pending-flash
    // on init.
    try {
      sessionStorage.setItem(
        "drawbang:pending-flash",
        JSON.stringify({ kind: "info", message: "Signed out.", autoDismissMs: 5500 }),
      );
    } catch {
      // private mode — the redirect still happens; just no flash.
    }
    location.assign("/");
  };

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
    // The logout link ships hidden (build-time chrome is logged-out); reveal
    // it now that a session is present and wire the sign-out action.
    const logoutLinks = document.querySelectorAll('[data-logout-link="1"]');
    for (const link of logoutLinks) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      link.hidden = false;
      link.addEventListener("click", logout);
    }
    // Owner-only affordances on cached SSR pages (e.g. the "Bookmarks" link
    // on /u/<un>). The element ships hidden so non-owners — and the edge
    // cache — never see it; we reveal it when the page's owner matches the
    // signed-in viewer.
    const ownerOnly = document.querySelectorAll("[data-owner-only-for]");
    for (const el of ownerOnly) {
      if (el.getAttribute("data-owner-only-for") === username) {
        el.hidden = false;
      }
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
})();
