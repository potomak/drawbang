import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";
import { TILES_PER_SIDE } from "../../config/murals.js";
import { esc } from "./_escape.js";

export interface MuralTileView {
  x: number;
  y: number;
  drawing_id?: string;
  claimed_by?: string;
  claim_expires_at?: number;
}

export interface MuralView {
  id: string;
  name: string;
  opens_at: string;
  closes_at: string;
  locked: boolean;
  // Baked tile state — empty array on a fresh mural. For active murals we
  // additionally include a small client script that hydrates from
  // /mural/{id}/state so the page stays live without rebuilding.
  tiles: MuralTileView[];
  state_url: string;
  repo_url: string;
}

export default function renderMural(v: MuralView): string {
  const byKey = new Map<string, MuralTileView>();
  for (const t of v.tiles) byKey.set(`${t.x},${t.y}`, t);

  const cells: string[] = [];
  for (let y = 0; y < TILES_PER_SIDE; y++) {
    for (let x = 0; x < TILES_PER_SIDE; x++) {
      cells.push(renderTile(v.id, v.locked, x, y, byKey.get(`${x},${y}`)));
    }
  }

  const status = v.locked
    ? `<span class="badge locked">Locked</span>`
    : `<span class="badge active">Active</span>`;

  // The hydration script only ships on active murals. Locked murals
  // render purely server-side and never change.
  const hydrate = v.locked
    ? ""
    : `<script>
(async function () {
  try {
    const res = await fetch(${JSON.stringify(v.state_url)});
    if (!res.ok) return;
    const state = await res.json();
    const grid = document.getElementById("mural-grid");
    if (!grid) return;
    const tiles = state.tiles || [];
    for (const t of tiles) {
      const cell = grid.querySelector('[data-tile="' + t.x + ',' + t.y + '"]');
      if (!cell) continue;
      if (t.drawing_id) {
        cell.innerHTML = '<a href="/t/' + t.drawing_id + '"><img src="/tiles/' + t.drawing_id + '.gif" alt="tile (' + t.x + ',' + t.y + ')" loading="lazy" /></a>';
        cell.dataset.state = "published";
      } else if (t.claimed_by) {
        cell.innerHTML = '<span class="cv-claimed" title="claimed by ' + t.claimed_by.slice(0, 8) + '">claimed</span>';
        cell.dataset.state = "claimed";
      }
    }
    const status = document.querySelector('[data-mural-progress]');
    if (status) {
      const published = tiles.filter(function (t) { return t.drawing_id; }).length;
      status.textContent = published + ' / ${TILES_PER_SIDE * TILES_PER_SIDE} tiles';
    }
  } catch (e) {
    // Hydration failures are non-fatal — the baked grid still renders.
  }
})();
</script>`;

  const progress = v.locked
    ? `${countPublished(v.tiles)} / ${TILES_PER_SIDE * TILES_PER_SIDE} tiles · final`
    : `${countPublished(v.tiles)} / ${TILES_PER_SIDE * TILES_PER_SIDE} tiles`;

  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(v.name)}</title>
    <link rel="stylesheet" href="/gallery-v2.css" />
    <style>
      .cv-grid{display:grid;grid-template-columns:repeat(${TILES_PER_SIDE},1fr);grid-template-rows:repeat(${TILES_PER_SIDE},1fr);gap:1px;background:#222;padding:1px;width:100%;max-width:528px;aspect-ratio:1;margin:1rem 0;}
      .cv-cell{background:#111;display:flex;align-items:center;justify-content:center;font-size:9px;color:#666;min-width:0;overflow:hidden;}
      .cv-cell img{width:100%;height:100%;image-rendering:pixelated;display:block;}
      .cv-cell a{display:block;width:100%;height:100%;line-height:1;text-align:center;}
      .cv-cell[data-state="open"] a{text-decoration:none;color:#888;display:flex;align-items:center;justify-content:center;}
      .cv-cell[data-state="open"]:hover{outline:1px solid #fff;}
      .cv-cell[data-state="claimed"]{background:#332;color:#aa8;}
      .cv-claimed{display:block;text-align:center;font-size:7px;line-height:1;word-break:break-all;}
      .badge{font-size:11px;padding:2px 6px;border-radius:3px;}
      .badge.active{background:#063;color:#cfd;}
      .badge.locked{background:#522;color:#fdc;}
      .cv-meta{margin:0.5rem 0 0;color:#888;font-size:13px;}
      @media (max-width: 480px) { .cv-cell, .cv-cell a { font-size: 7px; } .cv-claimed { font-size: 5px; } }
    </style>
  </head>
  <body>
    ${renderHeader({ active: "murals" })}
    <main>
      <h1 class="page-title">${esc(v.name)} ${status}</h1>
      <p class="cv-meta"><time datetime="${esc(v.opens_at)}">${esc(v.opens_at.slice(0, 10))}</time> → <time datetime="${esc(v.closes_at)}">${esc(v.closes_at.slice(0, 10))}</time> · <span data-mural-progress>${esc(progress)}</span></p>
      <div id="mural-grid" class="cv-grid" data-mural-id="${esc(v.id)}">
${cells.join("\n")}
      </div>
    </main>
    ${renderFooter({ active: "murals", repoUrl: v.repo_url })}
    ${hydrate}
  </body>
</html>
`;
}

function countPublished(tiles: MuralTileView[]): number {
  return tiles.filter((t) => t.drawing_id).length;
}

function renderTile(
  muralId: string,
  locked: boolean,
  x: number,
  y: number,
  tile: MuralTileView | undefined,
): string {
  const anchor = `tile-${x}-${y}`;
  const dataAttr = `data-tile="${x},${y}"`;

  if (tile?.drawing_id) {
    return `        <div id="${anchor}" class="cv-cell" ${dataAttr} data-state="published"><a href="/t/${esc(tile.drawing_id)}"><img src="/tiles/${esc(tile.drawing_id)}.gif" alt="tile (${x},${y})" loading="lazy" /></a></div>`;
  }

  if (locked) {
    // Locked + empty: never claimed before close. Show a dot, no interactivity.
    return `        <div id="${anchor}" class="cv-cell" ${dataAttr} data-state="empty">·</div>`;
  }

  if (tile?.claimed_by) {
    return `        <div id="${anchor}" class="cv-cell" ${dataAttr} data-state="claimed"><span class="cv-claimed" title="claimed">claimed</span></div>`;
  }

  return `        <div id="${anchor}" class="cv-cell" ${dataAttr} data-state="open"><a href="/?c=${esc(muralId)}&amp;x=${x}&amp;y=${y}" aria-label="Claim tile (${x}, ${y})">+</a></div>`;
}
