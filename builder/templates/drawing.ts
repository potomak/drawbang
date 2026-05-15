import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
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
    ? `<dt>Parent</dt><dd><a href="/d/${esc(v.parent.parent)}">${esc(v.parent.parent_short)}</a></dd>`
    : "";
  const ownerBlock = v.owner
    ? `<dt>Owner</dt><dd><a href="/keys/${esc(v.owner.pubkey)}">${esc(v.owner.pubkey_short)}</a></dd>`
    : `<dt>Owner</dt><dd>anonymous</dd>`;
  const created = formatCreatedAt(v.created_at);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(v.id_short)}</title>
    <link rel="stylesheet" href="/gallery-v2.css" />
    <meta property="og:image" content="/drawings/${esc(v.id)}.gif" />
  </head>
  <body>
    ${renderHeader({ active: "gallery" })}
    <main>
      <div class="dr-grid">
        <div class="dr-art-wrap">
          <img src="/drawings/${esc(v.id)}.gif" alt="drawing ${esc(v.id_short)}" width="540" height="540" />
        </div>
        <div>
          <dl class="dr-meta">
            <dt>Created</dt>
            <dd><time datetime="${esc(v.created_at)}">${esc(created)}</time></dd>
            ${ownerBlock}
            ${parentBlock}
            <dt>ID</dt>
            <dd><code class="mono-trunc">${esc(v.id_short)}…</code></dd>
          </dl>
          <div class="dr-actions">
            <a class="btn primary" href="/merch?d=${esc(v.id)}&amp;frame=0" rel="nofollow noreferrer">Make merch</a>
            <a class="btn" href="/?fork=${esc(v.id)}">Fork &amp; edit</a>
            <a class="btn" href="/d/${esc(v.id)}">Copy link</a>
            <a class="btn" href="/share?d=${esc(v.id)}" rel="nofollow noreferrer">Share to Reddit</a>
            <a class="btn ghost" href="/drawings/${esc(v.id)}.gif" download>Download GIF</a>
          </div>
          <details class="dr-adv">
            <summary>Advanced</summary>
            <dl>
              <dt>ID</dt><dd><code>${esc(v.id)}</code></dd>
              <dt>Minted</dt><dd><code>${esc(v.created_at)}</code></dd>
              <dt>Proof of work</dt><dd>${esc(v.required_bits)} bits in ${esc(v.solve_ms)}ms (${esc(v.bench_hps)} hps)</dd>
            </dl>
          </details>
        </div>
      </div>
    </main>
    ${renderFooter({ active: "gallery", repoUrl: v.repo_url })}
  </body>
</html>
`;
}
