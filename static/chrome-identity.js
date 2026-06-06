// Runtime patcher for the chrome's identity affordances. Vanilla JS,
// served at a stable URL. The editor mirrors the logged-in account's
// username to localStorage on login/logout so this script can read it
// synchronously and re-shape the markup before first paint.
//
// Responsibilities (all SSR ships logged-out; we patch when a session
// exists):
//   1. Header auth slot — swap "Sign in" for the profile-picture + name
//      link pointing at /u/<username>.
//   2. Left-rail follow blocks — fill in the username so hydrate.js
//      picks them up and stamps follower/following counts.
//   3. Bookmarks / Account / Sign-out left-rail rows — set the href
//      and reveal.
//   4. Owner-only affordances on cached SSR pages — reveal
//      [data-owner-only-for="<un>"] when the viewer matches.
//   5. Sign-out click handler — clear storage + queue a flash + redirect.

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
      // ignore storage errors — worst case the next page load still sees
      // a session, but the JWT removal almost always succeeds.
    }
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
    // 1. Header auth slot — hide "Sign in", reveal "profile pic + name".
    const signedOut = document.querySelectorAll('[data-auth-state="signed-out"]');
    for (const el of signedOut) {
      if (el instanceof HTMLElement) el.hidden = true;
    }
    const signedIn = document.querySelectorAll('[data-auth-state="signed-in"]');
    for (const el of signedIn) {
      if (!(el instanceof HTMLAnchorElement)) continue;
      el.href = "/u/" + username;
      el.hidden = false;
      const img = el.querySelector(".hdr-profile-pic");
      if (img instanceof HTMLImageElement) {
        img.setAttribute("data-profile-picture-username", username);
        img.setAttribute("data-profile-picture-size", "24");
        img.alt = username;
      }
      const name = el.querySelector(".hdr-profile-name");
      if (name) name.textContent = username;
    }

    // 2. Left-rail follow blocks — fill in the viewer's username so
    //    hydrate.js picks them up and stamps the counts.
    const followBlocks = document.querySelectorAll('[data-rail-follow]');
    for (const block of followBlocks) {
      if (!(block instanceof HTMLElement)) continue;
      block.setAttribute("data-profile-username", username);
      block.hidden = false;
      const kind = block.getAttribute("data-rail-follow");
      const link = block.querySelector('[data-rail-follow-link]');
      if (link instanceof HTMLAnchorElement && kind) {
        link.href = "/u/" + username + "/" + kind;
      }
    }

    // 3. Bookmarks / Account / Sign-out rows in the left rail.
    const bookmark = document.querySelector('[data-rail-bookmarks]');
    if (bookmark instanceof HTMLAnchorElement) {
      bookmark.href = "/u/" + username + "/bookmarks";
      bookmark.hidden = false;
    }
    const account = document.querySelector('[data-rail-account]');
    if (account instanceof HTMLAnchorElement) {
      account.hidden = false;
    }
    const logoutLinks = document.querySelectorAll('[data-logout-link="1"]');
    for (const link of logoutLinks) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      link.hidden = false;
      link.addEventListener("click", logout);
    }

    // 4. Owner-only affordances on cached SSR pages (e.g. the "Bookmarks"
    //    link on /u/<un>). Element ships hidden so non-owners — and the
    //    edge cache — never see it; we reveal when the page's owner
    //    matches the signed-in viewer.
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
