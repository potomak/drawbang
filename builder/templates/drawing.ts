import { esc } from "./_escape.js";

export interface DrawingView {
  id: string;
  id_short: string;
  created_at: string;
  required_bits: number | string;
  solve_ms: number | string;
  bench_hps: number | string;
  parent: { parent: string; parent_short: string } | null;
  drawings_base_url: string;
  // Pages-root prefix, e.g. "/drawbang/" when served from GH Pages. Must end
  // with a "/" so template concatenation like `${site_base}d/<id>` works.
  site_base: string;
}

export default function renderDrawing(v: DrawingView): string {
  const parentBlock = v.parent
    ? `<dt>parent</dt><dd><a href="${esc(v.site_base)}d/${esc(v.parent.parent)}">${esc(v.parent.parent_short)}</a></dd>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(v.id_short)}</title>
    <link rel="stylesheet" href="${esc(v.site_base)}gallery.css" />
    <meta property="og:image" content="${esc(v.drawings_base_url)}/${esc(v.id)}.gif" />
  </head>
  <body>
    <header>
      <h1><a href="${esc(v.site_base)}">Draw!</a></h1>
    </header>
    <main class="drawing-page">
      <img src="${esc(v.drawings_base_url)}/${esc(v.id)}.gif" alt="drawing ${esc(v.id_short)}" width="320" height="320" />
      <dl>
        <dt>id</dt><dd><code>${esc(v.id)}</code></dd>
        <dt>minted</dt><dd>${esc(v.created_at)}</dd>
        <dt>proof of work</dt><dd>${esc(v.required_bits)} bits in ${esc(v.solve_ms)}ms (${esc(v.bench_hps)} hps)</dd>
        ${parentBlock}
      </dl>
      <p>
        <a href="${esc(v.site_base)}?fork=${esc(v.id)}">fork this drawing</a>
      </p>
    </main>
  </body>
</html>
`;
}
