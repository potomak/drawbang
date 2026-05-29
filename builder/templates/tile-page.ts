import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";
import { esc } from "./_escape.js";
import type { GalleryItem } from "./gallery.js";
import { renderItem } from "./gallery.js";

// /t/<tile_id> — the canonical page for a single 16×16 tile (the atom). Tiles
// are content-addressed and reusable across canvases; this page is the
// unified successor to the old /d/<id> drawing page (every standalone gif is
// a tile now). It shows the gif, author, fork lineage, forks, and the
// share/merch/fork/download actions.

export interface TilePageView {
  tile_id: string;
  id_short: string;
  created_at: string;
  parent: { parent: string; parent_short: string } | null;
  // null on legacy tiles (published by an anonymous keypair before the
  // account system). They render as "anonymous" with no profile link.
  author: { user_id: string; username: string } | null;
  // Drawings that forked from this one. Empty/omitted when none, or for
  // the legacy static-render path that doesn't have a fork lookup
  // available. The dynamic /d/<id> handler queries GSI3 and passes the
  // results here.
  forks?: GalleryItem[];
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
  const gif = `/tiles/${esc(v.tile_id)}.gif`;
  const parentBlock = v.parent
    ? `<dt>Parent</dt><dd><a href="/t/${esc(v.parent.parent)}">${esc(v.parent.parent_short)}</a></dd>`
    : "";
  const authorBlock = v.author
    ? `<dt>Author</dt><dd><a href="/u/${esc(v.author.username)}">${esc(v.author.username)}</a></dd>`
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
    <link rel="canonical" href="${esc(v.public_base_url)}/t/${esc(v.tile_id)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Draw!" />
    <meta property="og:title" content="Tile ID ${esc(v.id_short)}" />
    <meta property="og:description" content="Pixel art from Draw! · Create your own pixel art at https://pixel.drawbang.com" />
    <meta property="og:url" content="${esc(v.public_base_url)}/t/${esc(v.tile_id)}" />
    <meta property="og:image" content="${esc(v.public_base_url)}/tiles/${esc(v.tile_id)}-large.gif" />
    <meta property="og:image:type" content="image/gif" />
    <meta property="og:image:width" content="960" />
    <meta property="og:image:height" content="960" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="stylesheet" href="/gallery-v2.css" />
  </head>
  <body>
    ${renderHeader({ active: "gallery" })}
    <main>
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
            <dt id="dr-children-dt" hidden>Children</dt>
            <dd id="dr-children-dd" hidden></dd>
            <dt>ID</dt>
            <dd><code class="mono-trunc">${esc(v.id_short)}</code></dd>
          </dl>
          <div class="dr-actions">
            <div class="dr-action-row">
              <a class="btn primary" id="dr-make-merch" href="/merch?d=${esc(v.tile_id)}&amp;frame=0" rel="nofollow noreferrer">Make merch</a>
              <a class="btn" id="dr-fork" href="/?fork=${esc(v.tile_id)}">Fork &amp; edit</a>
              <button class="btn" id="dr-copy-link" type="button">Copy link</button>
              <a class="btn ghost" id="dr-download-gif" href="${gif}" download>Download GIF</a>
            </div>
            <div class="dr-action-row">
              <a class="btn" id="dr-share-threads" href="https://www.threads.net/intent/post?text=${encodeURIComponent(`Pixel art from Draw! · Tile ID ${v.id_short}`)}&amp;url=${encodeURIComponent(`${v.public_base_url}/t/${v.tile_id}`)}" target="_blank" rel="nofollow noopener noreferrer">Share to Threads</a>
              <a class="btn" id="dr-share-reddit" href="https://www.reddit.com/submit?url=${encodeURIComponent(`${v.public_base_url}/t/${v.tile_id}`)}&amp;title=${encodeURIComponent(`Pixel art from Draw! · Tile ID ${v.id_short}`)}" target="_blank" rel="nofollow noopener noreferrer">Share to Reddit</a>
              <a class="btn" id="dr-share-x" href="https://twitter.com/intent/tweet?url=${encodeURIComponent(`${v.public_base_url}/t/${v.tile_id}`)}&amp;text=${encodeURIComponent(`Pixel art from Draw! · Tile ID ${v.id_short}`)}" target="_blank" rel="nofollow noopener noreferrer">Share to X</a>
              <button class="btn" id="dr-share" type="button" hidden>Share…</button>
            </div>
          </div>
        </div>
      </div>
${forksSection}
    </main>
    ${renderFooter({ active: "gallery", repoUrl: v.repo_url })}
    <script src="/flash.js"></script>
    <script>
(async function () {
  try {
    const id = ${JSON.stringify(v.tile_id)};
    const res = await fetch('/tiles/' + id + '.children.json', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const children = (data && data.children) || [];
    if (children.length === 0) return;
    const dt = document.getElementById('dr-children-dt');
    const dd = document.getElementById('dr-children-dd');
    if (!dt || !dd) return;
    var items = '';
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      items += '<li><a href="/t/' + c.id + '">' + c.id_short + '</a> · by <a href="/u/' + c.username + '">' + c.username + '</a></li>';
    }
    dd.innerHTML = '<ul class="dr-children">' + items + '</ul>';
    dt.hidden = false;
    dd.hidden = false;
  } catch (e) {
    // Non-fatal — parent page renders without the children section.
  }
})();
(function () {
  // Copy-link button — reuses the shared flash UI loaded via /flash.js
  // above (CLAUDE.md "UI/UX consistency"). Falls back to execCommand on
  // browsers without async-clipboard (older Safari, http:// contexts).
  var btn = document.getElementById('dr-copy-link');
  if (!btn) return;
  function flash(kind, message) {
    if (typeof window.drawbangShowFlash === 'function') {
      window.drawbangShowFlash({ kind: kind, message: message, autoDismissMs: 1800 });
    }
  }
  async function fallbackCopy(url) {
    var tmp = document.createElement('textarea');
    tmp.value = url;
    tmp.setAttribute('readonly', '');
    tmp.style.position = 'fixed';
    tmp.style.top = '-9999px';
    document.body.appendChild(tmp);
    tmp.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(tmp);
    return ok;
  }
  btn.addEventListener('click', async function () {
    var url = window.location.href;
    var ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      } else {
        ok = await fallbackCopy(url);
      }
    } catch (e) {
      ok = await fallbackCopy(url);
    }
    flash(ok ? 'success' : 'error', ok ? 'Link copied' : 'Could not copy — try long-pressing the URL');
    if (typeof window.gtag === 'function') window.gtag('event', 'copy_share_link_click', {});
  });
})();
(function () {
  // Web Share API. Progressive enhancement: the button stays hidden when
  // navigator.share is unavailable (notably desktop Firefox), so users on
  // those browsers fall back to the dedicated Reddit / X buttons.
  var btn = document.getElementById('dr-share');
  if (!btn) return;
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return;
  var payload = {
    title: 'Tile ID ' + ${JSON.stringify(v.id_short)},
    text: 'Pixel art from Draw!',
    url: window.location.href,
  };
  if (typeof navigator.canShare === 'function' && !navigator.canShare(payload)) return;
  btn.hidden = false;
  btn.addEventListener('click', async function () {
    if (typeof window.gtag === 'function') window.gtag('event', 'share_click', { target: 'web_share' });
    try {
      await navigator.share(payload);
    } catch (e) {
      if (e && e.name !== 'AbortError' && typeof window.drawbangShowFlash === 'function') {
        window.drawbangShowFlash({
          kind: 'error',
          message: 'Could not open share sheet',
          autoDismissMs: 1800,
        });
      }
    }
  });
})();
(function () {
  // Anchor-style action buttons. Each one's native navigation runs; we only
  // attach a click listener to fire a GA event. window.gtag is guarded so
  // DNT/opt-out users are silently no-op.
  function track(name, params) {
    if (typeof window.gtag !== 'function') return;
    window.gtag('event', name, params);
  }
  var tileId = ${JSON.stringify(v.tile_id)};
  var anchors = [
    { id: 'dr-make-merch',   event: 'make_merch_click',  props: { drawing_id: tileId } },
    { id: 'dr-fork',         event: 'fork_click',        props: { drawing_id: tileId } },
    { id: 'dr-share-threads',event: 'share_click',       props: { target: 'threads' } },
    { id: 'dr-share-reddit', event: 'share_click',       props: { target: 'reddit' } },
    { id: 'dr-share-x',      event: 'share_click',       props: { target: 'x' } },
    { id: 'dr-download-gif', event: 'gif_download_click', props: { source: 'tile_page' } },
  ];
  for (var i = 0; i < anchors.length; i++) {
    (function (a) {
      var el = document.getElementById(a.id);
      if (!el) return;
      el.addEventListener('click', function () { track(a.event, a.props); });
    })(anchors[i]);
  }
})();
    </script>
  </body>
</html>
`;
}
