import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { esc } from "./_escape.js";

export interface DayGalleryView {
  date: string;
  page: number;
  total_pages: number;
  drawings: { id: string; id_short: string }[];
  prev_page: { prev_page: number; date: string } | null;
  next_page: { next_page: number; date: string } | null;
  repo_url: string;
}

export default function renderDayGallery(v: DayGalleryView): string {
  const items = v.drawings
    .map(
      (d) => `          <li>
            <a href="/d/${esc(d.id)}">
              <img src="/drawings/${esc(d.id)}.gif" alt="drawing ${esc(d.id_short)}" width="128" height="128" loading="lazy" />
            </a>
          </li>`,
    )
    .join("\n");
  const prev = v.prev_page
    ? `<a href="/days/${esc(v.prev_page.date)}/p/${esc(v.prev_page.prev_page)}">← prev</a>`
    : "";
  const next = v.next_page
    ? `<a href="/days/${esc(v.next_page.date)}/p/${esc(v.next_page.next_page)}">next →</a>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(v.date)} · page ${esc(v.page)}</title>
    <link rel="stylesheet" href="/gallery.css" />
  </head>
  <body>
    ${renderHeader({ active: "gallery" })}
    <main>
      <h2>${esc(v.date)} — page ${esc(v.page)} of ${esc(v.total_pages)}</h2>
      <ul class="grid">
${items}
      </ul>
      <nav class="pager">
        ${prev}
        ${next}
      </nav>
    </main>
    ${renderFooter({ active: "gallery", repoUrl: v.repo_url })}
  </body>
</html>
`;
}
