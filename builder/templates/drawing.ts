import { esc } from "./_escape.js";

export interface DrawingView {
  id: string;
  id_short: string;
  created_at: string;
  required_bits: number | string;
  solve_ms: number | string;
  bench_hps: number | string;
  parent: { parent: string; parent_short: string } | null;
  // null on legacy drawings (pre-ownership feature). They render as
  // "anonymous" with no link. The operator backfill (#90) signs them with
  // the operator's keypair so this becomes uniform across the corpus.
  owner: { pubkey: string; pubkey_short: string } | null;
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
    ? `<dt>parent</dt><dd><a href="/d/${esc(v.parent.parent)}">${esc(v.parent.parent_short)}</a></dd>`
    : "";
  const ownerBlock = v.owner
    ? `<dt>owner</dt><dd><a href="/keys/${esc(v.owner.pubkey)}">${esc(v.owner.pubkey_short)}</a></dd>`
    : `<dt>owner</dt><dd>anonymous</dd>`;
  const created = formatCreatedAt(v.created_at);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(v.id_short)}</title>
    <link rel="stylesheet" href="/gallery.css" />
    <meta property="og:image" content="/drawings/${esc(v.id)}.gif" />
  </head>
  <body>
    <header>
      <h1><a href="/">Draw!</a></h1>
      <nav>
        <a href="/gallery">gallery</a>
        <a href="/products">products</a>
      </nav>
    </header>
    <main class="drawing-page">
      <img src="/drawings/${esc(v.id)}.gif" alt="drawing ${esc(v.id_short)}" width="320" height="320" />
      <p class="created-at">Created <time datetime="${esc(v.created_at)}">${esc(created)}</time></p>
      <dl class="meta">
        ${ownerBlock}
        ${parentBlock}
      </dl>
      <p>
        <a href="/?fork=${esc(v.id)}">fork this drawing</a>
      </p>
      <p>
        <a href="/merch?d=${esc(v.id)}&amp;frame=0" rel="nofollow noreferrer">make merch</a>
      </p>
      <p>
        <a href="/share?d=${esc(v.id)}" rel="nofollow noreferrer">share to Reddit</a>
      </p>
      <details class="advanced">
        <summary>Advanced</summary>
        <dl>
          <dt>id</dt><dd><code>${esc(v.id)}</code></dd>
          <dt>minted</dt><dd><code>${esc(v.created_at)}</code></dd>
          <dt>proof of work</dt><dd>${esc(v.required_bits)} bits in ${esc(v.solve_ms)}ms (${esc(v.bench_hps)} hps)</dd>
        </dl>
      </details>
    </main>
    <footer>
      <a href="${esc(v.repo_url)}" target="_blank" rel="noopener">source on github</a>
    </footer>
  </body>
</html>
`;
}
