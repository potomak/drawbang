import { renderAnalytics, renderFooter, renderHeader, renderMetaPixel } from "../../src/layout/chrome.js";
import { TILES_PER_CANVAS } from "../../config/canvases.js";
import { esc } from "./_escape.js";

export interface CanvasCard {
  id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  locked: boolean;
  tiles_published: number;
  // Up to 9 drawing ids to show as a preview mosaic; may be empty.
  preview_thumbs: string[];
}

export interface CanvasesArchiveView {
  current: CanvasCard | null;
  past: CanvasCard[];
  repo_url: string;
}

export default function renderCanvasesArchive(v: CanvasesArchiveView): string {
  const currentBlock = v.current
    ? `<h2 class="panel-h">This week</h2>
      <ul class="cv-list cv-list--current">
        ${renderCard(v.current)}
      </ul>`
    : "";

  const pastBlock = v.past.length > 0
    ? `<h2 class="panel-h">Past canvases</h2>
      <ul class="cv-list">
        ${v.past.map(renderCard).join("\n        ")}
      </ul>`
    : "";

  const empty = !v.current && v.past.length === 0
    ? `      <p class="muted">No canvases yet. The first one opens with the next builder run.</p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · Canvases</title>
    <link rel="stylesheet" href="/gallery-v2.css" />
    <style>
      .cv-list{list-style:none;padding:0;margin:0 0 2rem;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:1rem;}
      .cv-card{display:block;padding:0.75rem;border:1px solid #333;border-radius:6px;color:inherit;text-decoration:none;background:#0c0c0c;}
      .cv-card:hover{border-color:#666;}
      .cv-card h3{margin:0 0 0.25rem;font-size:14px;}
      .cv-card .cv-dates{color:#888;font-size:11px;}
      .cv-card .cv-status{font-size:11px;margin-top:0.25rem;}
      .cv-card .cv-status .locked{color:#fa8;}
      .cv-card .cv-status .active{color:#8fa;}
      .cv-thumbs{display:grid;grid-template-columns:repeat(3,32px);grid-template-rows:repeat(3,32px);gap:2px;margin:0.5rem 0;}
      .cv-thumbs img{width:32px;height:32px;image-rendering:pixelated;display:block;}
      .cv-thumbs .cv-empty{background:#222;width:32px;height:32px;}
    </style>
  </head>
  <body>
    ${renderHeader({ active: "canvases" })}
    <main>
      <h1 class="page-title">Canvases</h1>
${empty}
      ${currentBlock}
      ${pastBlock}
    </main>
    ${renderFooter({ active: "canvases", repoUrl: v.repo_url })}
  </body>
</html>
`;
}

function renderCard(c: CanvasCard): string {
  const thumbs: string[] = [];
  for (let i = 0; i < 9; i++) {
    const id = c.preview_thumbs[i];
    if (id) {
      thumbs.push(
        `<img src="/drawings/${esc(id)}.gif" alt="" loading="lazy" />`,
      );
    } else {
      thumbs.push(`<div class="cv-empty"></div>`);
    }
  }
  const status = c.locked
    ? `<span class="locked">Locked</span> · ${esc(c.tiles_published)}/${TILES_PER_CANVAS} tiles · final`
    : `<span class="active">Active</span> · ${esc(c.tiles_published)}/${TILES_PER_CANVAS} tiles`;
  return `<li>
          <a class="cv-card" href="/canvases/${esc(c.id)}">
            <h3>${esc(c.name)}</h3>
            <p class="cv-dates"><time datetime="${esc(c.opens_at)}">${esc(c.opens_at.slice(0, 10))}</time> → <time datetime="${esc(c.closes_at)}">${esc(c.closes_at.slice(0, 10))}</time></p>
            <div class="cv-thumbs">${thumbs.join("")}</div>
            <p class="cv-status">${status}</p>
          </a>
        </li>`;
}
