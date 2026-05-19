import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";
import { esc } from "./_escape.js";

export interface DrawingCanvasMembership {
  id: string;
  name: string;
  x: number;
  y: number;
  // The pubkey that claimed *this* tile use, which may differ from the
  // drawing author. Rendering attributes the canvas use to claimed_by so the
  // original author isn't implicated when key A puts key B's drawing in a
  // canvas.
  claimed_by: string;
  claimed_by_short: string;
}

export interface DrawingView {
  id: string;
  id_short: string;
  created_at: string;
  parent: { parent: string; parent_short: string } | null;
  // null on legacy drawings (pre-ownership feature). They render as
  // "anonymous" with no link. The operator backfill (#90) signs them with
  // the operator's keypair so this becomes uniform across the corpus.
  author: { pubkey: string; pubkey_short: string } | null;
  canvases?: DrawingCanvasMembership[];
  // Absolute base URL (e.g. https://pixel.drawbang.com) — needed for the
  // OG / canonical tags. Both ingest (cfg.publicBaseUrl) and the builder
  // (opts.publicBaseUrl) thread this in.
  public_base_url: string;
  repo_url: string;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Locale-neutral, server-renderable formatting of an ISO timestamp.
// Output is UTC-anchored on purpose — the static HTML can't follow the
// viewer's timezone without JS, and showing the same string everywhere
// avoids the minor confusion of "I made this at 4 AM but the page says
// 9 AM". Exported for unit tests.
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

export default function renderDrawing(v: DrawingView): string {
  const parentBlock = v.parent
    ? `<dt>Parent</dt><dd><a href="/d/${esc(v.parent.parent)}">${esc(v.parent.parent_short)}</a></dd>`
    : "";
  const authorBlock = v.author
    ? `<dt>Author</dt><dd><a href="/keys/${esc(v.author.pubkey)}">${esc(v.author.pubkey_short)}</a></dd>`
    : `<dt>Author</dt><dd>anonymous</dd>`;
  const canvases = v.canvases ?? [];
  const canvasesBlock = canvases.length > 0
    ? `<dt>Canvases</dt><dd><ul class="dr-canvases">${canvases
        .map(
          (c) =>
            `<li><a href="/canvases/${esc(c.id)}#tile-${c.x}-${c.y}">${esc(c.name)}</a> tile (${c.x}, ${c.y}) — by <a href="/keys/${esc(c.claimed_by)}">${esc(c.claimed_by_short)}</a></li>`,
        )
        .join("")}</ul></dd>`
    : "";
  const created = formatCreatedAt(v.created_at);
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(v.id_short)}</title>
    <meta name="description" content="Pixel art from Draw! · Create your own at https://pixel.drawbang.com" />
    <link rel="canonical" href="${esc(v.public_base_url)}/d/${esc(v.id)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Draw!" />
    <meta property="og:title" content="Drawing ID ${esc(v.id_short)}" />
    <meta property="og:description" content="Pixel art from Draw! · Create your own pixel art at https://pixel.drawbang.com" />
    <meta property="og:url" content="${esc(v.public_base_url)}/d/${esc(v.id)}" />
    <meta property="og:image" content="${esc(v.public_base_url)}/drawings/${esc(v.id)}-large.gif" />
    <meta property="og:image:type" content="image/gif" />
    <meta property="og:image:width" content="320" />
    <meta property="og:image:height" content="320" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="stylesheet" href="/gallery-v2.css" />
  </head>
  <body>
    ${renderHeader({ active: "gallery" })}
    <main>
      <div class="dr-grid">
        <div class="dr-art-wrap">
          <img src="/drawings/${esc(v.id)}.gif" alt="drawing ${esc(v.id_short)}" width="320" height="320" />
        </div>
        <div>
          <dl class="dr-meta">
            <dt>Created</dt>
            <dd><time datetime="${esc(v.created_at)}">${esc(created)}</time></dd>
            ${authorBlock}
            ${parentBlock}
            ${canvasesBlock}
            <dt id="dr-children-dt" hidden>Children</dt>
            <dd id="dr-children-dd" hidden></dd>
            <dt>ID</dt>
            <dd><code class="mono-trunc">${esc(v.id_short)}</code></dd>
          </dl>
          <div class="dr-actions">
            <a class="btn primary" href="/merch?d=${esc(v.id)}&amp;frame=0" rel="nofollow noreferrer">Make merch</a>
            <a class="btn" href="/?fork=${esc(v.id)}">Fork &amp; edit</a>
            <button class="btn" id="dr-copy-link" type="button">Copy link</button>
            <button class="btn" id="dr-share" type="button" hidden>Share…</button>
            <a class="btn" href="https://www.reddit.com/submit?url=${encodeURIComponent(`${v.public_base_url}/d/${v.id}`)}&amp;title=${encodeURIComponent(`Pixel art from Draw! · Drawing ID ${v.id_short}`)}" target="_blank" rel="nofollow noopener noreferrer">Share to Reddit</a>
            <a class="btn" href="https://twitter.com/intent/tweet?url=${encodeURIComponent(`${v.public_base_url}/d/${v.id}`)}&amp;text=${encodeURIComponent(`Pixel art from Draw! · Drawing ID ${v.id_short}`)}" target="_blank" rel="nofollow noopener noreferrer">Share to X</a>
            <a class="btn ghost" href="/drawings/${esc(v.id)}.gif" download>Download GIF</a>
          </div>
        </div>
      </div>
    </main>
    ${renderFooter({ active: "gallery", repoUrl: v.repo_url })}
    <script src="/flash.js"></script>
    <script>
(async function () {
  try {
    const id = ${JSON.stringify(v.id)};
    const res = await fetch('/drawings/' + id + '.children.json', { cache: 'no-store' });
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
      items += '<li><a href="/d/' + c.id + '">' + c.id_short + '</a> · by <a href="/keys/' + c.pubkey + '">' + c.pubkey_short + '</a></li>';
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
  });
})();
(function () {
  // Web Share API. Progressive enhancement: the button stays hidden when
  // navigator.share is unavailable (notably desktop Firefox), so users on
  // those browsers fall back to the dedicated Reddit / X buttons. On
  // mobile + modern desktop, one tap opens the OS share sheet — every
  // installed app the user has, no per-platform intent URL to maintain.
  var btn = document.getElementById('dr-share');
  if (!btn) return;
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return;
  var payload = {
    title: 'Drawing ID ' + ${JSON.stringify(v.id_short)},
    text: 'Pixel art from Draw!',
    url: window.location.href,
  };
  // canShare is the stricter preflight (some browsers reject a payload
  // shape silently otherwise). Skip the check when the API isn't there.
  if (typeof navigator.canShare === 'function' && !navigator.canShare(payload)) return;
  btn.hidden = false;
  btn.addEventListener('click', async function () {
    try {
      await navigator.share(payload);
    } catch (e) {
      // AbortError = user dismissed the sheet — not an error, no flash.
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
    </script>
  </body>
</html>
`;
}
