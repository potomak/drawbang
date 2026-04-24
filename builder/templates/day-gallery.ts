import { esc } from "./_escape.js";

export interface DayGalleryView {
  date: string;
  page: number;
  total_pages: number;
  drawings: { id: string; id_short: string }[];
  prev_page: { prev_page: number; date: string } | null;
  next_page: { next_page: number; date: string } | null;
  drawings_base_url: string;
  site_base: string;
}

export default function renderDayGallery(v: DayGalleryView): string {
  const items = v.drawings
    .map(
      (d) => `          <li>
            <a href="${esc(v.site_base)}d/${esc(d.id)}">
              <img src="${esc(v.drawings_base_url)}/${esc(d.id)}.gif" alt="drawing ${esc(d.id_short)}" width="128" height="128" loading="lazy" />
            </a>
          </li>`,
    )
    .join("\n");
  const prev = v.prev_page
    ? `<a href="${esc(v.site_base)}days/${esc(v.prev_page.date)}/p/${esc(v.prev_page.prev_page)}">← prev</a>`
    : "";
  const next = v.next_page
    ? `<a href="${esc(v.site_base)}days/${esc(v.next_page.date)}/p/${esc(v.next_page.next_page)}">next →</a>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(v.date)} · page ${esc(v.page)}</title>
    <link rel="stylesheet" href="${esc(v.site_base)}gallery.css" />
  </head>
  <body>
    <header>
      <h1><a href="${esc(v.site_base)}">Draw!</a></h1>
      <nav><a href="${esc(v.site_base)}days/${esc(v.date)}/p/1">${esc(v.date)}</a></nav>
    </header>
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
  </body>
</html>
`;
}
