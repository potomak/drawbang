import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";
import type { BadgeDef } from "../../config/badges.js";
import { esc } from "./_escape.js";

export interface OwnerStats {
  daily_total: number;
  daily_streak_current: number;
  daily_streak_longest: number;
  canvas_total: number;
  canvas_streak_current: number;
  canvas_streak_longest: number;
  daily_badges: BadgeDef[];
  canvas_badges: BadgeDef[];
}

export interface OwnerView {
  pubkey: string;        // 64 hex
  pubkey_short: string;  // first 8
  // Newest-first.
  drawings: { id: string; id_short: string }[];
  // Per-pubkey stats (#115/#116). Optional: a brand-new owner with no
  // user_stats row yet renders as all-zeros via builder coercion. The
  // template renders nothing when omitted so legacy tests / dev paths
  // stay unaffected.
  stats?: OwnerStats;
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
  const count = v.drawings.length;
  const countLabel = `${count} ${count === 1 ? "drawing" : "drawings"}`;
  const body = count
    ? `      <p class="page-sub">${esc(countLabel)}</p>
      <ul class="img-grid">
${items}
      </ul>`
    : `      <p class="muted">No drawings published with this key yet.</p>`;
  const stats = v.stats ? renderStats(v.stats) : "";
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · key ${esc(v.pubkey_short)}</title>
    <link rel="stylesheet" href="/gallery-v2.css" />
  </head>
  <body>
    ${renderHeader({ active: "identity" })}
    <main>
      <h1 class="page-title">Drawings by ${esc(v.pubkey_short)}</h1>
${stats}${body}
    </main>
    ${renderFooter({ active: "identity", repoUrl: v.repo_url })}
  </body>
</html>
`;
}

function renderStats(s: OwnerStats): string {
  const dailyLine = s.daily_total === 0
    ? `No drawings yet`
    : `${esc(s.daily_streak_current)}-day streak · best ${esc(s.daily_streak_longest)} · ${esc(s.daily_total)} drawing${s.daily_total === 1 ? "" : "s"} total`;
  const canvasLine = s.canvas_total === 0
    ? `No weekly canvases yet`
    : `${esc(s.canvas_streak_current)}-week streak · best ${esc(s.canvas_streak_longest)} · ${esc(s.canvas_total)} canvas${s.canvas_total === 1 ? "" : "es"} total`;
  const badges = [...s.daily_badges, ...s.canvas_badges];
  const badgesBlock = badges.length === 0
    ? ""
    : `      <dt>Badges</dt>
      <dd><ul class="ow-badges">${badges
        .map((b) => `<li data-badge-id="${esc(b.id)}">${esc(b.label)}</li>`)
        .join("")}</ul></dd>
`;
  return `      <dl class="ow-stats">
      <dt>Daily drawings</dt>
      <dd>${dailyLine}</dd>
      <dt>Weekly canvas</dt>
      <dd>${canvasLine}</dd>
${badgesBlock}      </dl>
`;
}
