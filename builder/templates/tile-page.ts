import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";
import { esc } from "./_escape.js";

// /t/<tile_id> — a single 16×16 tile (the atom). Tiles are content-addressed
// and reusable across canvases/murals; this is their canonical address.

export interface TilePageView {
  tile_id: string;
  id_short: string;
  public_base_url: string;
  repo_url: string;
}

export default function renderTilePage(v: TilePageView): string {
  const gif = `/tiles/${esc(v.tile_id)}.gif`;
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · tile ${esc(v.id_short)}</title>
    <link rel="canonical" href="${esc(v.public_base_url)}/t/${esc(v.tile_id)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Draw!" />
    <meta property="og:title" content="Tile ${esc(v.id_short)}" />
    <meta property="og:url" content="${esc(v.public_base_url)}/t/${esc(v.tile_id)}" />
    <meta property="og:image" content="${esc(v.public_base_url)}${gif}" />
    <link rel="stylesheet" href="/gallery-v2.css" />
    <style>
      .tl-art{width:100%;max-width:320px;aspect-ratio:1;image-rendering:pixelated;display:block;background:var(--canvas-bg);margin:1rem 0;}
    </style>
  </head>
  <body>
    ${renderHeader({ active: "gallery" })}
    <main>
      <h1 class="page-title">Tile ${esc(v.id_short)}</h1>
      <img class="tl-art" src="${gif}" alt="tile ${esc(v.id_short)}" width="320" height="320" />
      <dl class="dr-meta">
        <dt>ID</dt>
        <dd><code class="mono-trunc">${esc(v.id_short)}</code></dd>
      </dl>
      <div class="dr-actions">
        <div class="dr-action-row">
          <a class="btn ghost" href="${gif}" download>Download GIF</a>
          <button class="btn" id="tl-copy-link" type="button">Copy link</button>
        </div>
      </div>
    </main>
    ${renderFooter({ active: "gallery", repoUrl: v.repo_url })}
    <script src="/flash.js"></script>
    <script>
(function () {
  var btn = document.getElementById('tl-copy-link');
  if (!btn) return;
  btn.addEventListener('click', async function () {
    var ok = false;
    try { await navigator.clipboard.writeText(window.location.href); ok = true; } catch (e) { ok = false; }
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
