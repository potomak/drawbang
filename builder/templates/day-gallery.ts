import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { esc } from "./_escape.js";

export interface DayGalleryView {
  date: string;
  page: number;
  total_pages: number;
  drawings: { id: string; id_short: string }[];
  prev_page: { prev_page: number; date: string } | null;
  next_page: { next_page: number; date: string } | null;
  // Adjacent days that have drawings. null at the edges of the archive.
  prev_day: string | null;
  next_day: string | null;
  repo_url: string;
}

export default function renderDayGallery(v: DayGalleryView): string {
  const items = v.drawings
    .map(
      (d) => `          <li>
            <a href="/d/${esc(d.id)}" aria-label="drawing ${esc(d.id_short)}">
              <img src="/drawings/${esc(d.id)}.gif" alt="" width="128" height="128" loading="lazy" />
            </a>
          </li>`,
    )
    .join("\n");
  const prev = v.prev_page
    ? `<a href="/days/${esc(v.prev_page.date)}/p/${esc(v.prev_page.prev_page)}">← Prev</a>`
    : "";
  const next = v.next_page
    ? `<a href="/days/${esc(v.next_page.date)}/p/${esc(v.next_page.next_page)}">Next →</a>`
    : "";
  const prevDay = v.prev_day
    ? `<a href="/days/${esc(v.prev_day)}/p/1">← ${esc(v.prev_day)}</a>`
    : "";
  const nextDay = v.next_day
    ? `<a href="/days/${esc(v.next_day)}/p/1">${esc(v.next_day)} →</a>`
    : "";
  const dayNav = (prevDay || nextDay)
    ? `      <nav class="day-nav" aria-label="Adjacent days">
        ${prevDay}
        ${nextDay}
      </nav>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(v.date)} · page ${esc(v.page)}</title>
    <link rel="stylesheet" href="/gallery-v2.css" />
  </head>
  <body>
    ${renderHeader({ active: "gallery" })}
    <main>
      <h1 class="page-title">${esc(v.date)}</h1>
      <p class="page-sub">Page ${esc(v.page)} of ${esc(v.total_pages)}</p>
      <ul class="img-grid">
${items}
      </ul>
      <nav class="pager">
        ${prev}
        ${next}
      </nav>
${dayNav}
    </main>
    ${renderFooter({ active: "gallery", repoUrl: v.repo_url })}
  </body>
</html>
`;
}
