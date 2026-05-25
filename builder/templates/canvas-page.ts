import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";
import { esc } from "./_escape.js";
import { formatCreatedAt } from "./tile-page.js";

// /c/<canvas_id> — a personal multi-tile drawing rendered as a CSS grid of the
// live per-tile gifs (so each cell animates). A 1×1 canvas renders a single
// tile. The static composite (public/c/<id>.png) is used for OG/thumbnails.

export interface CanvasPageView {
  canvas_id: string;
  id_short: string;
  cols: number;
  rows: number;
  // Row-major, length cols*rows. null = empty cell.
  tiles: (string | null)[];
  // null on legacy/unauthored — renders without a profile link.
  author: { username: string } | null;
  created_at: string;
  // OG/thumbnail image URL (composite png for multi-tile, the tile gif for 1×1).
  preview_url: string;
  public_base_url: string;
  repo_url: string;
}

export default function renderCanvasPage(v: CanvasPageView): string {
  const cells: string[] = [];
  for (let i = 0; i < v.tiles.length; i++) {
    const tileId = v.tiles[i];
    cells.push(
      tileId
        ? `        <div class="cn-cell"><a href="/t/${esc(tileId)}"><img src="/tiles/${esc(tileId)}.gif" alt="" loading="lazy" /></a></div>`
        : `        <div class="cn-cell cn-empty"></div>`,
    );
  }
  const authorBlock = v.author
    ? `<dt>Author</dt><dd><a href="/u/${esc(v.author.username)}">${esc(v.author.username)}</a></dd>`
    : `<dt>Author</dt><dd>anonymous</dd>`;
  const created = formatCreatedAt(v.created_at);
  const ogImage = `${esc(v.public_base_url)}${esc(v.preview_url)}`;

  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(v.id_short)}</title>
    <meta name="description" content="Pixel art from Draw! · Create your own at https://pixel.drawbang.com" />
    <link rel="canonical" href="${esc(v.public_base_url)}/c/${esc(v.canvas_id)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Draw!" />
    <meta property="og:title" content="Canvas ${esc(v.id_short)}" />
    <meta property="og:url" content="${esc(v.public_base_url)}/c/${esc(v.canvas_id)}" />
    <meta property="og:image" content="${ogImage}" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="stylesheet" href="/gallery-v2.css" />
    <style>
      .cn-grid{display:grid;grid-template-columns:repeat(${v.cols},1fr);gap:0;background:var(--canvas-bg);width:100%;max-width:${v.cols * 64}px;aspect-ratio:${v.cols} / ${v.rows};margin:1rem 0;}
      .cn-cell{min-width:0;overflow:hidden;}
      .cn-cell img{width:100%;height:100%;image-rendering:pixelated;display:block;}
      .cn-empty{background:var(--canvas-bg);}
    </style>
  </head>
  <body>
    ${renderHeader({ active: "gallery" })}
    <main>
      <h1 class="page-title">Canvas ${esc(v.id_short)}</h1>
      <div class="cn-grid">
${cells.join("\n")}
      </div>
      <dl class="dr-meta">
        <dt>Created</dt>
        <dd><time datetime="${esc(v.created_at)}">${esc(created)}</time></dd>
        ${authorBlock}
        <dt>Size</dt>
        <dd>${v.cols}×${v.rows} tiles</dd>
        <dt>ID</dt>
        <dd><code class="mono-trunc">${esc(v.id_short)}</code></dd>
      </dl>
      <div class="dr-actions">
        <div class="dr-action-row">
          <a class="btn" id="cn-fork" href="/?fork=${esc(v.canvas_id)}">Fork &amp; edit</a>
          <button class="btn" id="cn-copy-link" type="button">Copy link</button>
        </div>
      </div>
    </main>
    ${renderFooter({ active: "gallery", repoUrl: v.repo_url })}
    <script src="/flash.js"></script>
    <script>
(function () {
  var btn = document.getElementById('cn-copy-link');
  if (!btn) return;
  btn.addEventListener('click', async function () {
    var url = window.location.href;
    var ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch (e) { ok = false; }
    if (typeof window.drawbangShowFlash === 'function') {
      window.drawbangShowFlash({ kind: ok ? 'success' : 'error', message: ok ? 'Link copied' : 'Could not copy', autoDismissMs: 1800 });
    }
  });
})();
    </script>
  </body>
</html>
`;
}
