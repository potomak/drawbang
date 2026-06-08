import { assetUrl } from "../../src/layout/asset-version.js";
import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { esc } from "./_escape.js";
import { renderHtmlShell } from "./_html-shell.js";
import { renderFeedCard, type FeedItem } from "./home.js";

// /u/<username>/bookmarks — the owner's saved drawings, newest-saved
// first. The page itself ships no per-user data — an inline boot script
// reads the JWT from localStorage, redirects on a missing or mismatched
// session, then loads /me/bookmarks/feed (auth-gated) and replaces the
// placeholder list with the rendered feed cards.
//
// This shape exists because browser navigations don't carry the
// Authorization header — the SSR'd HTML can't be gated against the JWT
// directly. Going through a fetch keeps the data path behind a Bearer-
// auth'd endpoint without sacrificing the canonical URL.

export interface BookmarksView {
  username: string;
  // Pre-rendered feed items. The page renders them inline; when omitted
  // (the typical browser-navigation path), the inline boot script
  // fetches /me/bookmarks/feed and fills the list.
  items: FeedItem[];
  repo_url: string;
}

export default function renderBookmarksPage(v: BookmarksView): string {
  const cards = v.items.map(renderFeedCard).join("\n");
  return renderHtmlShell({
    title: "Draw! · Your bookmarks",
    extraHead: `<meta name="robots" content="noindex" />`,
    bodyAttrs: `data-bookmarks-page data-bookmarks-username="${esc(v.username)}"`,
    body: `    ${renderHeader({ active: "identity" })}
    <main>
      <h1 class="page-title">Your bookmarks</h1>
      <p class="feed-empty" data-bookmarks-empty hidden>No bookmarks yet — tap the ribbon on any drawing to save it here.</p>
      <p class="feed-empty" data-bookmarks-loading>Loading your bookmarks…</p>
      <ul class="feed-list" data-bookmarks-list>
${cards}      </ul>
    </main>
    ${renderFooter({ active: "identity", repoUrl: v.repo_url })}
    ${renderBootScript()}
    <script src="${assetUrl("/toggle-handler.js")}"></script>
    <script src="${assetUrl("/like.js")}"></script>
    <script src="${assetUrl("/share.js")}"></script>
    <script src="${assetUrl("/bookmark.js")}"></script>`,
  });
}

// Inline auth + fetch dance. Plain JS so the bookmarks page can ship as
// a single Lambda response without depending on a separate bundle.
function renderBootScript(): string {
  return `    <script>
(function () {
  var body = document.body;
  var owner = body.getAttribute("data-bookmarks-username") || "";
  var jwt = null;
  var un = null;
  try {
    jwt = localStorage.getItem("drawbang:jwt");
    un = localStorage.getItem("drawbang:username");
  } catch (e) {}
  if (!jwt) {
    var next = encodeURIComponent(location.pathname + location.search);
    location.replace("/login?next=" + next);
    return;
  }
  // JWT in hand but the URL targets someone else's bookmarks — silently
  // bounce to the caller's own page. Don't leak whose page they tried.
  if (un && owner && un !== owner) {
    location.replace("/u/" + un + "/bookmarks");
    return;
  }
  fetch("/me/bookmarks/feed", {
    headers: { Authorization: "Bearer " + jwt },
  })
    .then(function (res) {
      if (res.status === 401) {
        var next = encodeURIComponent(location.pathname + location.search);
        location.replace("/login?next=" + next);
        return null;
      }
      return res.ok ? res.text() : null;
    })
    .then(function (html) {
      var loading = document.querySelector("[data-bookmarks-loading]");
      if (loading) loading.hidden = true;
      var list = document.querySelector("[data-bookmarks-list]");
      var empty = document.querySelector("[data-bookmarks-empty]");
      if (html === null) return;
      if (list) {
        list.innerHTML = html;
      }
      var trimmed = (html || "").trim();
      if (!trimmed && empty) empty.hidden = false;
      if (trimmed && empty) empty.hidden = true;
    })
    .catch(function () {
      var loading = document.querySelector("[data-bookmarks-loading]");
      if (loading) loading.textContent = "Couldn't load your bookmarks.";
    });
})();
    </script>
`;
}
