import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";
import { esc } from "./_escape.js";
import { formatItemDate } from "./_time.js";
import { renderAvatar } from "./owner.js";

// `/` — the social feed home. Vertical card list, mobile-first, single
// column on small screens with a max-width container on larger ones.
// Reuses `renderAvatar()` for the author block and the same infinite-
// scroll observer pattern as the legacy gallery (kept inline here — one
// consumer, low cost).

export interface FeedAuthor {
  username: string;
  avatar_drawing_id: string | null;
}

export interface FeedItem {
  id: string;            // drawing_id
  id_short: string;      // first 8 chars, used in aria labels
  thumb: string;         // /tiles/<id>.gif
  href: string;          // /d/<id>
  created_at: string;    // ISO 8601
  like_count: number;    // SSR initial value; client hydrates filled state
  // null for legacy "anonymous" rows that predate accounts. Render the
  // card without a profile link in that case.
  author: FeedAuthor | null;
}

export interface HomeView {
  items: FeedItem[];
  // When present, the feed renders an infinite-scroll sentinel + observer
  // that GETs this URL to append the next page.
  next_fragment_url?: string;
  repo_url: string;
}

export function renderFeedCard(item: FeedItem): string {
  const authorBlock = item.author
    ? `<a class="feed-card-author-link" href="/u/${esc(item.author.username)}">${renderAvatar(item.author.avatar_drawing_id, item.author.username, 36)}<span>@${esc(item.author.username)}</span></a>`
    : `<span class="feed-card-author-link feed-card-author-anon">anonymous</span>`;
  const date = formatItemDate(item.created_at);
  return `<li><article class="feed-card">
  <header class="feed-card-author">
    ${authorBlock}
    <time class="feed-card-time" datetime="${esc(item.created_at)}">${esc(date)}</time>
  </header>
  <a class="feed-card-art" href="${esc(item.href)}" aria-label="View drawing ${esc(item.id_short)}">
    <img src="${esc(item.thumb)}" alt="" width="256" height="256" loading="lazy" />
  </a>
  <footer class="feed-card-meta">
    ${renderLikeButton(item.id, item.like_count)}
    <a class="feed-card-permalink" href="${esc(item.href)}">View</a>
  </footer>
</article></li>`;
}

// Heart button shared by the feed cards + the drawing page. Filled state is
// hydrated client-side by `/like.js` against `GET /me/likes?ids=…`; the
// initial SSR markup is always the outline state with the canonical count.
export function renderLikeButton(drawing_id: string, like_count: number): string {
  return `<button class="like-btn" type="button" data-like-target="${esc(drawing_id)}" aria-pressed="false" aria-label="Like this drawing">
      <svg class="like-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 21s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.65-7 10-7 10z"/></svg>
      <span class="like-count" data-like-count>${like_count}</span>
    </button>`;
}

// Items-only render (no chrome). Used by /feed/items?cursor=… so the
// observer can append the next page in place. Mirrors the data-attribute
// contract the inline observer below reads.
export function renderFeedFragment(
  items: FeedItem[],
  next_fragment_url: string | null,
): string {
  const cards = items.map(renderFeedCard).join("\n");
  if (!next_fragment_url) return cards;
  return `${cards}
<li class="feed-sentinel" data-feed-sentinel data-next="${esc(next_fragment_url)}"></li>`;
}

export default function renderHome(v: HomeView): string {
  const cards = v.items.map(renderFeedCard).join("\n");
  const empty = v.items.length === 0;
  const body = empty
    ? `      <p class="feed-empty">No drawings yet — be the first: <a href="/draw">open the editor</a>.</p>`
    : `      <ul class="feed-list" data-feed-list>
${cards}${v.next_fragment_url ? `
        <li class="feed-sentinel" data-feed-sentinel data-next="${esc(v.next_fragment_url)}"></li>` : ""}
      </ul>`;
  // Only ship the IntersectionObserver script when there's actually a
  // sentinel to observe. Saves a few hundred bytes on the empty + last-
  // page renders, and keeps assertions that "the empty page contains
  // no data-feed-sentinel string anywhere" honest.
  const observerScript = v.next_fragment_url ? renderObserverScript() : "";
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw!</title>
    <link rel="stylesheet" href="/gallery-v2.css" />
  </head>
  <body>
    ${renderHeader({ active: "home" })}
    <main>
${body}
    </main>
    ${renderFooter({ active: "home", repoUrl: v.repo_url })}
${observerScript}    <script src="/like.js"></script>
  </body>
</html>
`;
}

function renderObserverScript(): string {
  return `    <script>
(function () {
  // Infinite-scroll sentinel observer. Same shape as the gallery's
  // legacy script; lives inline because the feed is the only consumer.
  function wire(sentinel) {
    if (!sentinel || sentinel.dataset.wired) return;
    sentinel.dataset.wired = "1";
    var next = sentinel.dataset.next;
    if (!next) return;
    var io = new IntersectionObserver(async function (entries) {
      if (!entries.some(function (e) { return e.isIntersecting; })) return;
      io.disconnect();
      try {
        var res = await fetch(next);
        if (!res.ok) return;
        var html = await res.text();
        var list = document.querySelector("[data-feed-list]");
        if (list) {
          sentinel.remove();
          list.insertAdjacentHTML("beforeend", html);
        }
        var nextSentinel = document.querySelector("[data-feed-sentinel]:not([data-wired])");
        if (nextSentinel) wire(nextSentinel);
      } catch (e) {
        // Network/decoding error: the sentinel is gone; refresh to retry.
      }
    }, { rootMargin: "200px" });
    io.observe(sentinel);
  }
  document.querySelectorAll("[data-feed-sentinel]").forEach(wire);
})();
    </script>
`;
}
