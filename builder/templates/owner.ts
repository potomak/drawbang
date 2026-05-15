import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
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
            <a href="/d/${esc(d.id)}" aria-label="drawing ${esc(d.id_short)}">
              <img src="/drawings/${esc(d.id)}.gif" alt="" width="128" height="128" loading="lazy" />
            </a>
          </li>`,
    )
    .join("\n");
  const body = v.drawings.length
    ? `      <ul class="img-grid">
${items}
      </ul>`
    : `      <p class="muted">No drawings published with this key yet.</p>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · key ${esc(v.pubkey_short)}</title>
    <link rel="stylesheet" href="/gallery-v2.css" />
  </head>
  <body>
    ${renderHeader({ active: "identity" })}
    <main>
      <h1 class="page-title">Drawings by ${esc(v.pubkey_short)}</h1>
      <p class="prof-key-text">${esc(v.pubkey)}</p>
${body}
    </main>
    ${renderFooter({ active: "identity", repoUrl: v.repo_url })}
  </body>
</html>
`;
}
