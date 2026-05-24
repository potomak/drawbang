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
  username: string;      // public handle, used in the URL
  user_id: string;       // 64-hex stable id, used for stats hydration
  // Newest-first.
  drawings: { id: string; id_short: string }[];
  // Per-pubkey stats (#115/#116). Optional: a brand-new owner with no
  // user_stats row yet renders as all-zeros via builder coercion. The
  // template renders nothing when omitted so legacy tests / dev paths
  // stay unaffected.
  stats?: OwnerStats;
  // Optional: when set, the page ships an inline hydration script that
  // GETs this URL on load and overlays fresh stats on the server-rendered
  // ones. Without it the stats block is whatever the last builder run
  // emitted (typically hours stale).
  stats_url?: string;
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
    : `      <p class="muted">No drawings published by this account yet.</p>`;
  const stats = v.stats ? renderStats(v.stats) : "";
  const hydrate = v.stats && v.stats_url ? renderHydrateScript(v.stats_url) : "";
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(v.username)}</title>
    <link rel="stylesheet" href="/gallery-v2.css" />
  </head>
  <body>
    ${renderHeader({ active: "identity" })}
    <main>
      <h1 class="page-title">Drawings by ${esc(v.username)}</h1>
${stats}${body}
    </main>
    ${renderFooter({ active: "identity", repoUrl: v.repo_url })}
    ${hydrate}
  </body>
</html>
`;
}

function renderStats(s: OwnerStats): string {
  const dailyLine = formatDailyLine(s);
  const canvasLine = formatCanvasLine(s);
  const badges = [...s.daily_badges, ...s.canvas_badges];
  // Badges row always emitted (hidden when empty server-side) so the
  // hydration script can unhide it without DOM construction when fresh
  // stats unlock a new tier between builder runs.
  const badgesHidden = badges.length === 0 ? " hidden" : "";
  return `      <dl class="ow-stats">
      <dt>Daily drawings</dt>
      <dd data-stats-daily>${dailyLine}</dd>
      <dt>Weekly canvas</dt>
      <dd data-stats-canvas>${canvasLine}</dd>
      <dt data-stats-badges-dt${badgesHidden}>Badges</dt>
      <dd data-stats-badges-dd${badgesHidden}><ul class="ow-badges" data-stats-badges>${badges
        .map((b) => `<li data-badge-id="${esc(b.id)}">${esc(b.label)}</li>`)
        .join("")}</ul></dd>
      </dl>
`;
}

function formatDailyLine(s: OwnerStats): string {
  if (s.daily_total === 0) return "No drawings yet";
  return `${esc(s.daily_streak_current)}-day streak · best ${esc(s.daily_streak_longest)} · ${esc(s.daily_total)} drawing${s.daily_total === 1 ? "" : "s"} total`;
}

function formatCanvasLine(s: OwnerStats): string {
  if (s.canvas_total === 0) return "No weekly canvases yet";
  return `${esc(s.canvas_streak_current)}-week streak · best ${esc(s.canvas_streak_longest)} · ${esc(s.canvas_total)} canvas${s.canvas_total === 1 ? "" : "es"} total`;
}

function renderHydrateScript(statsUrl: string): string {
  // Inline because the owner page doesn't load any other JS bundles. Keeps
  // the read-side optional: a transient API outage or ad blocker just
  // leaves the server-rendered values in place. Stats endpoint already
  // sets Cache-Control: max-age=15 so two visits within ~15s hit edge,
  // not the Lambda.
  return `<script>
(async function () {
  try {
    const res = await fetch(${JSON.stringify(statsUrl)});
    if (!res.ok) return;
    const s = await res.json();
    const daily = document.querySelector('[data-stats-daily]');
    const canvas = document.querySelector('[data-stats-canvas]');
    if (daily) daily.textContent = s.daily_total === 0
      ? 'No drawings yet'
      : s.daily_streak_current + '-day streak · best ' + s.daily_streak_longest + ' · ' + s.daily_total + ' drawing' + (s.daily_total === 1 ? '' : 's') + ' total';
    if (canvas) canvas.textContent = s.canvas_total === 0
      ? 'No weekly canvases yet'
      : s.canvas_streak_current + '-week streak · best ' + s.canvas_streak_longest + ' · ' + s.canvas_total + ' canvas' + (s.canvas_total === 1 ? '' : 'es') + ' total';
    const all = (s.daily_badges || []).concat(s.canvas_badges || []);
    const ul = document.querySelector('[data-stats-badges]');
    const dt = document.querySelector('[data-stats-badges-dt]');
    const dd = document.querySelector('[data-stats-badges-dd]');
    if (ul) {
      var items = '';
      for (var i = 0; i < all.length; i++) {
        var b = all[i];
        items += '<li data-badge-id="' + b.id + '">' + b.label + '</li>';
      }
      ul.innerHTML = items;
    }
    if (dt) dt.hidden = all.length === 0;
    if (dd) dd.hidden = all.length === 0;
  } catch (e) {
    // Non-fatal — server-rendered values stand.
  }
})();
</script>`;
}
