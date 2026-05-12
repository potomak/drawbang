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
            <a href="/d/${esc(d.id)}">
              <img src="/drawings/${esc(d.id)}.gif" alt="drawing ${esc(d.id_short)}" width="128" height="128" loading="lazy" />
            </a>
          </li>`,
    )
    .join("\n");
  const archive = v.days
    .map(
      (d) => `        <li><a href="/days/${esc(d.date)}/p/1">${esc(d.date)}</a> · ${esc(d.count)} drawings</li>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw!</title>
    <link rel="stylesheet" href="/gallery.css" />
  </head>
  <body>
    <header>
      <h1><a href="/">Draw!</a></h1>
      <nav>
        <a href="/gallery" aria-current="page" class="active">gallery</a>
        <a href="/products">products</a>
      </nav>
    </header>
    <main>
      <h2>latest — ${esc(v.today)}</h2>
      <ul class="grid">
${items}
      </ul>
      <h2>archive</h2>
      <ul class="archive">
${archive}
      </ul>
    </main>
    <footer>
      <a href="${esc(v.repo_url)}" target="_blank" rel="noopener">source on github</a>
    </footer>
  </body>
</html>
`;
}
