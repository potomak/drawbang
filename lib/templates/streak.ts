import { assetUrl } from "../../src/layout/asset-version.js";
import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";
import { esc } from "./_escape.js";
import { renderProfilePicture } from "./owner.js";

export type DayKind = "thumb" | "empty" | "out-of-range";

export interface DayCell {
  date: string;
  day: number;
  kind: DayKind;
  drawing_id?: string;
}

export interface MonthBlock {
  year: number;
  month: number;
  label: string;
  cells: DayCell[];
}

export interface StreakView {
  username: string;
  profile_picture_drawing_id?: string | null;
  daily_streak_current: number;
  daily_streak_longest: number;
  total_days_drawn: number;
  months: MonthBlock[];
  repo_url: string;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function renderDayCell(cell: DayCell, username: string): string {
  if (cell.kind === "out-of-range") {
    return `<li class="st-day st-day-out" aria-hidden="true"></li>`;
  }
  if (cell.kind === "thumb" && cell.drawing_id) {
    const human = humanDate(cell.date);
    return `<li class="st-day st-day-thumb"><a href="/d/${esc(cell.drawing_id)}" title="${esc(human)} — ${esc(username)}"><img src="/tiles/${esc(cell.drawing_id)}.gif" alt="" loading="lazy" width="64" height="64" /><span class="st-day-num">${cell.day}</span></a></li>`;
  }
  return `<li class="st-day st-day-empty"><span class="st-day-num">${cell.day}</span></li>`;
}

function renderMonth(block: MonthBlock, username: string): string {
  const cells = block.cells.map((c) => renderDayCell(c, username)).join("");
  return `      <li class="st-month">
        <h2 class="st-month-label">${esc(block.label)}</h2>
        <ol class="st-day-grid">${cells}</ol>
      </li>`;
}

function humanDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export default function renderStreak(v: StreakView): string {
  const empty = v.months.length === 0;
  const summary = empty
    ? `<p class="page-sub">No drawings published yet.</p>`
    : `<p class="page-sub">${esc(v.daily_streak_current)}-day streak · best ${esc(v.daily_streak_longest)} · ${esc(v.total_days_drawn)} day${v.total_days_drawn === 1 ? "" : "s"} with drawings</p>`;
  const body = empty
    ? `      <p class="muted">${esc(v.username)} hasn't published any drawings yet — once they do, the streak calendar will show up here.</p>`
    : `      <ol class="st-week-head" aria-hidden="true">${WEEKDAY_LABELS.map((d) => `<li>${d}</li>`).join("")}</ol>
      <ol class="st-months">
${v.months.map((m) => renderMonth(m, v.username)).join("\n")}
      </ol>`;
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(v.username)} · Streak calendar</title>
    <meta name="description" content="Daily publishing calendar for ${esc(v.username)} on Draw!" />
    <link rel="stylesheet" href="${assetUrl("/gallery-v2.css")}" />
  </head>
  <body>
    ${renderHeader({ active: "identity" })}
    <main>
      <h1 class="page-title">${renderProfilePicture(v.profile_picture_drawing_id, v.username, 32)}Streak calendar for ${esc(v.username)}</h1>
      ${summary}
      <p class="st-back"><a href="/u/${esc(v.username)}">← back to profile</a></p>
${body}
    </main>
    ${renderFooter({ active: "identity", repoUrl: v.repo_url })}
  </body>
</html>
`;
}
