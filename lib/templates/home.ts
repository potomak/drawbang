import type { Prompt } from "../../config/prompts.js";
import { assetUrl } from "../../src/layout/asset-version.js";
import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { esc } from "./_escape.js";
import { renderHtmlShell } from "./_html-shell.js";
import { formatItemDate } from "./_time.js";

// `/` — the social feed home. Vertical card list, mobile-first, single
// column on small screens with a max-width container on larger ones.
// The infinite-scroll observer is shared with the other paginated
// surfaces via /infinite-scroll.js.

export interface FeedAuthor {
  username: string;
  profile_picture_drawing_id: string | null;
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
  // Feed ordering. "top" = most-liked of the last 24 hours, bounded to
  // one page with no infinite scroll. Absent/"new" = chronological.
  sort?: "new" | "top";
  // Today's daily prompt. When present, a banner renders above the feed
  // with a "Draw this" CTA. The /feed/items fragment path never sets it.
  prompt?: Prompt;
  // discover_rail_html: pre-rendered HTML for the right "discover"
  // rail (lib/templates/discover.ts). Empty / undefined → the rail
  // is rendered empty.
  discover_rail_html?: string;
  // When present, the feed renders an infinite-scroll sentinel + observer
  // that GETs this URL to append the next page.
  next_fragment_url?: string;
  repo_url: string;
}

export function renderFeedCard(item: FeedItem): string {
  const date = formatItemDate(item.created_at);
  const pp = renderFeedProfilePicture(item.author);
  const ppBlock = item.author
    ? `<a class="feed-card-pp" href="/u/${esc(item.author.username)}" aria-label="${esc(item.author.username)}'s profile">${pp}</a>`
    : `<span class="feed-card-pp">${pp}</span>`;
  const author = item.author
    ? `<a class="feed-card-author-link" href="/u/${esc(item.author.username)}">${esc(item.author.username)}</a>`
    : `<span class="feed-card-author-link feed-card-author-anon">anonymous</span>`;
  return `<li><article class="feed-card">
  ${ppBlock}
  <div class="feed-card-main">
    <header class="feed-card-author">
      ${author}
      <span class="feed-card-sep" aria-hidden="true">·</span>
      <time class="feed-card-time" datetime="${esc(item.created_at)}">${esc(date)}</time>
    </header>
    <a class="feed-card-art" href="${esc(item.href)}" aria-label="Open drawing ${esc(item.id_short)}">
      <img src="${esc(item.thumb)}" alt="" width="256" height="256" loading="lazy" />
    </a>
    <div class="feed-card-actions">
      ${renderLikeButton(item.id, item.like_count)}
      ${renderForkAction(item.id)}
      ${renderBookmarkButton(item.id)}
      ${renderShareAction(item.id, item.id_short)}
    </div>
  </div>
</article></li>`;
}

// Profile picture for the feed-card left rail. Falls back to a monogram
// placeholder when the author hasn't set one (or the row is anonymous)
// so the column width stays consistent across cards.
function renderFeedProfilePicture(author: FeedAuthor | null): string {
  const size = 48;
  const pic = author?.profile_picture_drawing_id;
  // Anonymous cards (no author) emit an untagged placeholder — there's no
  // username to hydrate against.
  if (!author?.username) {
    return `<span class="profile-picture profile-picture-placeholder" aria-hidden="true">?</span>`;
  }
  const dataAttrs = `data-profile-picture-username="${esc(author.username)}" data-profile-picture-size="${size}"`;
  if (pic && /^[0-9a-f]{64}$/.test(pic)) {
    return `<img class="profile-picture" src="/tiles/${esc(pic)}.gif" alt="${esc(author.username)}" width="${size}" height="${size}" loading="lazy" ${dataAttrs} />`;
  }
  const letter = author.username.charAt(0).toUpperCase();
  return `<span class="profile-picture profile-picture-placeholder" aria-hidden="true" ${dataAttrs}>${esc(letter)}</span>`;
}

// Heart button shared by the feed cards + the drawing page. Filled state is
// hydrated client-side by `/like.js` against `GET /me/likes?ids=…`; the
// initial SSR markup is always the outline state with the canonical count.
export function renderLikeButton(drawing_id: string, like_count: number): string {
  return `<button class="like-btn feed-action" type="button" data-like-target="${esc(drawing_id)}" aria-pressed="false" aria-label="Like this drawing">
      <svg class="like-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 21s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.65-7 10-7 10z"/></svg>
      <span class="like-count" data-like-count>${like_count}</span>
    </button>`;
}

// Bookmark button shared by feed cards + the drawing page. Filled state
// is hydrated client-side by `/bookmark.js` against
// `GET /me/bookmarks?ids=…`; the SSR markup is always outline.
export function renderBookmarkButton(drawing_id: string): string {
  return `<button class="bookmark-btn feed-action" type="button" data-bookmark-target="${esc(drawing_id)}" aria-pressed="false" aria-label="Bookmark this drawing">
      <svg class="bookmark-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>
    </button>`;
}

function renderForkAction(drawing_id: string): string {
  return `<a class="feed-action" href="/draw?fork=${esc(drawing_id)}" aria-label="Remix this drawing">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="7" cy="5" r="2"/><circle cx="17" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M7 7v3c0 1.1 .9 2 2 2h6c1.1 0 2-.9 2-2V7"/><path d="M12 12v5"/></svg>
      <span>Remix</span>
    </a>`;
}

function renderShareAction(drawing_id: string, id_short: string): string {
  const title = `Pixel art from Draw! · Tile ID ${id_short}`;
  return `<button class="feed-action" type="button" data-share-button data-share-target="/d/${esc(drawing_id)}" data-share-title="${esc(title)}" aria-label="Share drawing">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3v13"/><path d="M7 8l5-5 5 5"/><path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5"/></svg>
      <span>Share</span>
    </button>`;
}

// Items-only render (no chrome). Used by /feed/items?cursor=… so the
// observer can append the next page in place.
export function renderFeedFragment(
  items: FeedItem[],
  next_fragment_url: string | null,
): string {
  const cards = items.map(renderFeedCard).join("\n");
  if (!next_fragment_url) return cards;
  return `${cards}
${renderFeedSentinel(next_fragment_url)}`;
}

// Daily-prompt banner above the feed. The view-fire gtag call is inlined
// (guarded, runs once at parse) rather than shipped as a static/*.js file
// — same precedent as the bookmarks page boot script. The slug is
// JSON-encoded with `<` escaped so it can never close the script element.
function renderPromptBanner(p: Prompt): string {
  const slugJs = JSON.stringify(p.slug).replace(/</g, "\\u003c");
  return `<section class="prompt-banner" aria-label="Today's prompt">
        <p class="panel-h prompt-banner-kicker">Today's prompt</p>
        <h2 class="prompt-banner-title">${esc(p.title)}</h2>
        <p class="prompt-banner-blurb">${esc(p.blurb)}</p>
        <a class="btn primary prompt-banner-cta" href="/draw?prompt=${esc(p.slug)}">Draw this</a>
        <script>typeof gtag==="function"&&gtag("event","prompt_banner_view",{slug:${slugJs}});</script>
      </section>`;
}

// Logged-out pitch above the feed. SSR always renders it (the page is
// edge-cached and identity-blind); chrome-identity.js hides every
// [data-signed-out-only] element when a session exists. Samples are the
// newest feed items — live content, nothing hardcoded.
function renderHero(items: FeedItem[]): string {
  const samples = items
    .slice(0, 3)
    .map(
      (it) =>
        `<img class="home-hero-sample" src="${esc(it.thumb)}" alt="" width="64" height="64" loading="lazy" />`,
    )
    .join("");
  const samplesBlock = samples
    ? `\n        <div class="home-hero-samples" aria-hidden="true">${samples}</div>`
    : "";
  return `<section class="home-hero" data-signed-out-only aria-label="About Draw!">
        <h1 class="home-hero-title">Make a looping 16×16 sprite in 60 seconds</h1>
        <ol class="home-hero-steps">
          <li>Pick a color and draw</li>
          <li>Add frames to make it loop</li>
          <li>Publish, share, and remix</li>
        </ol>${samplesBlock}
        <a class="btn primary home-hero-cta" href="/draw">Start drawing</a>
        <form class="home-hero-subscribe" data-subscribe-form>
          <label class="lab" for="subscribe-email">Get launch notes by email</label>
          <div class="home-hero-subscribe-row">
            <input id="subscribe-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required />
            <input class="home-hero-subscribe-trap" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" />
            <button class="btn" type="submit">Subscribe</button>
          </div>
        </form>
      </section>`;
}

function renderFeedSortNav(sort: "new" | "top"): string {
  const link = (href: string, label: string, active: boolean): string =>
    `<a class="feed-sort-link" href="${href}"${active ? ` aria-current="page"` : ""}>${label}</a>`;
  return `<nav class="feed-sort" aria-label="Feed sort">
        ${link("/", "Newest", sort === "new")}
        ${link("/?sort=top", "Top today", sort === "top")}
      </nav>`;
}

export default function renderHome(v: HomeView): string {
  const sort = v.sort ?? "new";
  const cards = v.items.map(renderFeedCard).join("\n");
  const empty = v.items.length === 0;
  const banner = v.prompt ? `      ${renderPromptBanner(v.prompt)}\n` : "";
  const emptyCopy =
    sort === "top"
      ? `Nothing published in the last 24 hours — <a href="/draw">draw the first</a>.`
      : `No drawings yet — be the first: <a href="/draw">open the editor</a>.`;
  const body = empty
    ? `      <p class="feed-empty">${emptyCopy}</p>`
    : `      <ul class="feed-list" data-infinite-list>
${cards}${v.next_fragment_url ? `
        ${renderFeedSentinel(v.next_fragment_url)}` : ""}
      </ul>`;
  // Only the feed shows the right "discover" rail. Other surfaces
  // (drawing, profile, products, design) inherit the default and stay 2-col.
  const footerOpts = {
    active: "home",
    repoUrl: v.repo_url,
    rightRail: true,
    rightRailContent: v.discover_rail_html ?? "",
  };
  // Only ship the infinite-scroll script when there's a sentinel to
  // observe — saves a few hundred bytes on empty + last-page renders.
  const infiniteScript = v.next_fragment_url
    ? `    <script src="${assetUrl("/infinite-scroll.js")}"></script>\n`
    : "";
  return renderHtmlShell({
    title: "Draw!",
    body: `    ${renderHeader({ active: "home", rightRail: true })}
    <main>
      ${renderHero(v.items)}
${banner}      ${renderFeedSortNav(sort)}
${body}
    </main>
    ${renderFooter(footerOpts)}
${infiniteScript}    <script src="${assetUrl("/toggle-handler.js")}"></script>
    <script src="${assetUrl("/like.js")}"></script>
    <script src="${assetUrl("/bookmark.js")}"></script>
    <script src="${assetUrl("/share.js")}"></script>
    <script src="${assetUrl("/subscribe.js")}"></script>`,
  });
}

function renderFeedSentinel(nextUrl: string): string {
  return `<li class="feed-sentinel" data-infinite-sentinel data-infinite-target="[data-infinite-list]" data-next="${esc(nextUrl)}"></li>`;
}
