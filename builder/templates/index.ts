import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { esc } from "./_escape.js";

export interface IndexView {
  today: string;
  drawings: { id: string; id_short: string }[];
  days: { date: string; count: number; pages: number }[];
  repo_url: string;
}

export default function renderIndex(v: IndexView): string {
  const items = v.drawings
    .map(
      (d) => `          <li>
            <a href="/d/${esc(d.id)}" aria-label="drawing ${esc(d.id_short)}">
              <img src="/drawings/${esc(d.id)}.gif" alt="" width="128" height="128" loading="lazy" />
            </a>
          </li>`,
    )
    .join("\n");
  const archive = v.days
    .map(
      (d) => `        <li><a href="/days/${esc(d.date)}/p/1">${esc(d.date)}</a> <span class="gal-count">— ${esc(d.count)} ${d.count === 1 ? "drawing" : "drawings"}</span></li>`,
    )
    .join("\n");
  const latestSection = v.drawings.length
    ? `      <p class="panel-h">Latest · ${esc(v.today)}</p>
      <ul class="img-grid">
${items}
      </ul>`
    : `      <p class="panel-h">Latest · ${esc(v.today)}</p>
      <p class="muted">No drawings published yet — open <a href="/">the editor</a> and mint the first one.</p>`;
  const archiveSection = v.days.length
    ? `      <hr class="divider" />
      <p class="panel-h">Archive</p>
      <ul class="gal-archive-list">
${archive}
      </ul>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · Gallery</title>
    <link rel="stylesheet" href="/gallery-v2.css" />
  </head>
  <body>
    ${renderHeader({ active: "gallery" })}
    <main>
      <h1 class="page-title">Gallery</h1>
${latestSection}
${archiveSection}
    </main>
    ${renderFooter({ active: "gallery", repoUrl: v.repo_url })}
  </body>
</html>
`;
}
