import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";

export interface NotFoundView {
  repo_url: string;
}

export default function renderNotFound(v: NotFoundView): string {
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · Not found</title>
    <meta name="robots" content="noindex" />
    <link rel="stylesheet" href="/gallery-v2.css" />
  </head>
  <body>
    ${renderHeader()}
    <main>
      <h1 class="page-title">Page not found</h1>
      <p>
        Try the <a href="/gallery">gallery</a>, the
        <a href="/canvases">canvases archive</a>, or open
        <a href="/">the editor</a> and draw something new.
      </p>
    </main>
    ${renderFooter({ repoUrl: v.repo_url })}
  </body>
</html>
`;
}
