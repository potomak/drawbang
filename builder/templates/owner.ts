import { esc } from "./_escape.js";

export interface OwnerView {
  pubkey: string;        // 64 hex
  pubkey_short: string;  // first 8
  // Newest-first.
  drawings: { id: string; id_short: string }[];
  repo_url: string;
}

export default function renderOwner(v: OwnerView): string {
  const items = v.drawings
    .map(
      (d) => `          <li>
            <a href="/d/${esc(d.id)}">
              <img src="/drawings/${esc(d.id)}.gif" alt="drawing ${esc(d.id_short)}" width="128" height="128" loading="lazy" />
            </a>
          </li>`,
    )
    .join("\n");
  const count = v.drawings.length;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · key ${esc(v.pubkey_short)}</title>
    <link rel="stylesheet" href="/gallery.css" />
  </head>
  <body>
    <header>
      <h1><a href="/">Draw!</a></h1>
    </header>
    <main class="owner-page">
      <h2>drawings by <code>${esc(v.pubkey_short)}</code></h2>
      <p class="owner-pubkey"><code>${esc(v.pubkey)}</code></p>
      <p class="owner-disclaimer">this gallery groups drawings made with the same key — there's no account or login behind it.</p>
      <p class="owner-count">${esc(count)} drawing${count === 1 ? "" : "s"}.</p>
      <ul class="grid">
${items}
      </ul>
    </main>
    <footer>
      <a href="${esc(v.repo_url)}" target="_blank" rel="noopener">source on github</a>
    </footer>
  </body>
</html>
`;
}
