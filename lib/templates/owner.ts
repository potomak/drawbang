import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";
import type { BadgeDef } from "../../config/badges.js";
import type { GalleryItem } from "./gallery.js";
import { esc } from "./_escape.js";

export interface OwnerStats {
  daily_total: number;
  daily_streak_current: number;
  daily_streak_longest: number;
  daily_badges: BadgeDef[];
}

export interface OwnerView {
  username: string;      // public handle, used in the URL
  user_id: string;       // 64-hex stable id
  // Newest-first.
  drawings: GalleryItem[];
  // Per-account stats (#115/#116). Optional: a brand-new owner with no
  // user_stats row yet renders as all-zeros from the handler. The
  // template renders nothing when omitted so dev/test paths stay
  // unaffected.
  stats?: OwnerStats;
  // drawing_id the user picked as their avatar. Renders a small inline
  // gif next to the username when set.
  avatar_drawing_id?: string | null;
  repo_url: string;
}

// Inline avatar next to a username. Returns "" when drawing_id is missing
// or malformed so callers can splice it in unconditionally.
export function renderAvatar(
  drawing_id: string | null | undefined,
  username: string,
  size: number,
): string {
  if (!drawing_id || !/^[0-9a-f]{64}$/.test(drawing_id)) return "";
  const px = Math.max(8, Math.floor(size));
  return `<img class="avatar" src="/tiles/${esc(drawing_id)}.gif" alt="${esc(username)}" width="${px}" height="${px}" loading="lazy" />`;
}

export default function renderOwner(v: OwnerView): string {
  const items = v.drawings
    .map(
      (d) => `          <li>
            <a href="${esc(d.href ?? `/d/${d.id}`)}" aria-label="${esc(d.id_short)}">
              <img src="${esc(d.thumb ?? `/tiles/${d.id}.gif`)}" alt="" width="128" height="128" loading="lazy" />
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
      <h1 class="page-title">${renderAvatar(v.avatar_drawing_id, v.username, 32)}Drawings by ${esc(v.username)}</h1>
${stats}${body}
    </main>
    ${renderFooter({ active: "identity", repoUrl: v.repo_url })}
  </body>
</html>
`;
}

function renderStats(s: OwnerStats): string {
  const dailyLine = formatDailyLine(s);
  const badges = s.daily_badges;
  const badgesHidden = badges.length === 0 ? " hidden" : "";
  return `      <dl class="ow-stats">
      <dt>Daily drawings</dt>
      <dd data-stats-daily>${dailyLine}</dd>
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
