// TODO (#shared-template-utils): HTML head/shell duplication — see
// home.ts for the lift-to-_html-shell plan.

import { assetUrl } from "../../src/layout/asset-version.js";
import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";
import { esc } from "./_escape.js";
import type { GalleryItem } from "./gallery.js";
import { renderItem } from "./gallery.js";
import { renderBookmarkButton, renderLikeButton } from "./home.js";
import { renderProfilePicture } from "./owner.js";

// /d/<drawing_id> — the canonical page for a single drawing. Content-
// addressed (id = sha256(gif)). Shows the gif, author, fork lineage,
// forks, and the share/merch/fork/download actions. Filename stays
// `tile-page.ts` until the rename ships in a follow-up; the field
// `drawing_id` is the drawing id.

export interface TilePageView {
  drawing_id: string;
  id_short: string;
  created_at: string;
  parent: { parent: string; parent_short: string } | null;
  // null on legacy tiles (published by an anonymous keypair before the
  // account system). They render as "anonymous" with no profile link.
  // profile_picture_drawing_id is null when the author hasn't picked a
  // profile picture yet (or doesn't have a real account row).
  author: {
    user_id: string;
    username: string;
    profile_picture_drawing_id: string | null;
  } | null;
  // Drawings that forked from this one. Empty/omitted when none, or for
  // the legacy static-render path that doesn't have a fork lookup
  // available. The dynamic /d/<id> handler queries GSI3 and passes the
  // results here.
  forks?: GalleryItem[];
  // SSR initial like count. Filled state is hydrated by /like.js.
  like_count: number;
  public_base_url: string;
  repo_url: string;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Locale-neutral, server-renderable formatting of an ISO timestamp.
// UTC-anchored on purpose — the static HTML can't follow the viewer's
// timezone without JS. Exported for unit tests.
export function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${month} ${day}, ${year} · ${hh}:${mm} UTC`;
}

export default function renderTilePage(v: TilePageView): string {
  const gif = `/tiles/${esc(v.drawing_id)}.gif`;
  const parentBlock = v.parent
    ? `<dt>Parent</dt><dd><a href="/d/${esc(v.parent.parent)}">${esc(v.parent.parent_short)}</a></dd>`
    : "";
  const authorBlock = v.author
    ? `<dt>Author</dt><dd><a class="dr-author" href="/u/${esc(v.author.username)}">${renderProfilePicture(v.author.profile_picture_drawing_id, v.author.username, 20)}${esc(v.author.username)}</a></dd>`
    : `<dt>Author</dt><dd>anonymous</dd>`;
  const created = formatCreatedAt(v.created_at);
  const forks = v.forks ?? [];
  const forksSection = forks.length > 0
    ? `      <section class="dr-forks">
        <p class="panel-h">Forks · ${forks.length}</p>
        <ul class="img-grid">
${forks.map(renderItem).join("\n")}
        </ul>
      </section>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(v.id_short)}</title>
    <meta name="description" content="Pixel art from Draw! · Create your own at https://pixel.drawbang.com" />
    <link rel="canonical" href="${esc(v.public_base_url)}/d/${esc(v.drawing_id)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Draw!" />
    <meta property="og:title" content="Tile ID ${esc(v.id_short)}" />
    <meta property="og:description" content="Pixel art from Draw! · Create your own pixel art at https://pixel.drawbang.com" />
    <meta property="og:url" content="${esc(v.public_base_url)}/d/${esc(v.drawing_id)}" />
    <meta property="og:image" content="${esc(v.public_base_url)}/tiles/${esc(v.drawing_id)}-large.gif" />
    <meta property="og:image:type" content="image/gif" />
    <meta property="og:image:width" content="960" />
    <meta property="og:image:height" content="960" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="stylesheet" href="${assetUrl("/gallery-v2.css")}" />
  </head>
  <body>
    ${renderHeader({ active: "home" })}
    <main data-tile-page data-drawing-id="${esc(v.drawing_id)}" data-id-short="${esc(v.id_short)}" data-author-username="${esc(v.author?.username ?? "")}">
      <div class="dr-grid">
        <div class="dr-art-wrap">
          <img src="${gif}" alt="tile ${esc(v.id_short)}" width="320" height="320" />
        </div>
        <div>
          <dl class="dr-meta">
            <dt>Created</dt>
            <dd><time datetime="${esc(v.created_at)}">${esc(created)}</time></dd>
            ${authorBlock}
            ${parentBlock}
            <dt>ID</dt>
            <dd><code class="mono-trunc">${esc(v.id_short)}</code></dd>
          </dl>
          <div class="dr-actions">
            <div class="dr-action-row">
              ${renderLikeButton(v.drawing_id, v.like_count)}
              ${renderBookmarkButton(v.drawing_id)}
              <a class="btn primary" id="dr-make-merch" href="/merch?d=${esc(v.drawing_id)}&amp;frame=0" rel="nofollow noreferrer">Make merch</a>
              <a class="btn" id="dr-fork" href="/draw?fork=${esc(v.drawing_id)}">Fork &amp; edit</a>
              <button class="btn" id="dr-set-profile-picture" type="button" hidden>Set as profile picture</button>
              <button class="btn" id="dr-copy-link" type="button">Copy link</button>
              <a class="btn ghost" id="dr-download-gif" href="${gif}" download>Download GIF</a>
            </div>
            <div class="dr-action-row">
              <a class="btn" id="dr-share-threads" href="https://www.threads.net/intent/post?text=${encodeURIComponent(`Pixel art from Draw! · Tile ID ${v.id_short}`)}&amp;url=${encodeURIComponent(`${v.public_base_url}/d/${v.drawing_id}`)}" target="_blank" rel="nofollow noopener noreferrer">Share to Threads</a>
              <a class="btn" id="dr-share-reddit" href="https://www.reddit.com/submit?url=${encodeURIComponent(`${v.public_base_url}/d/${v.drawing_id}`)}&amp;title=${encodeURIComponent(`Pixel art from Draw! · Tile ID ${v.id_short}`)}" target="_blank" rel="nofollow noopener noreferrer">Share to Reddit</a>
              <a class="btn" id="dr-share-x" href="https://twitter.com/intent/tweet?url=${encodeURIComponent(`${v.public_base_url}/d/${v.drawing_id}`)}&amp;text=${encodeURIComponent(`Pixel art from Draw! · Tile ID ${v.id_short}`)}" target="_blank" rel="nofollow noopener noreferrer">Share to X</a>
              <button class="btn" id="dr-share" type="button" hidden>Share…</button>
            </div>
          </div>
        </div>
      </div>
${forksSection}
    </main>
    ${renderFooter({ active: "home", repoUrl: v.repo_url })}
    <script src="${assetUrl("/flash.js")}"></script>
    <script src="${assetUrl("/tile-page.js")}"></script>
    <script src="${assetUrl("/toggle-handler.js")}"></script>
    <script src="${assetUrl("/like.js")}"></script>
    <script src="${assetUrl("/bookmark.js")}"></script>
  </body>
</html>
`;
}
