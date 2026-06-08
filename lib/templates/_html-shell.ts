import { assetUrl } from "../../src/layout/asset-version.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";

// Shared `<!doctype html>` + `<head>` + `<body>` wrapper for every
// Lambda-rendered template. Each template's `body` string carries its
// own chrome (header, main, footer, scripts) — the shell only owns the
// boilerplate that was duplicated across all of them: doctype, lang,
// charset, viewport, analytics + Meta Pixel, gallery-v2.css link,
// title.
//
// Per-page extras:
//   bodyAttrs   — attributes appended after `<body` (the leading space
//                 is added automatically).
//   extraHead   — additional `<head>` content (per-page <meta>, OG tags,
//                 inline <style>, etc.).
export interface HtmlShellOptions {
  title: string;
  bodyAttrs?: string;
  extraHead?: string;
  body: string;
}

export function renderHtmlShell(opts: HtmlShellOptions): string {
  const bodyAttrs = opts.bodyAttrs ? ` ${opts.bodyAttrs}` : "";
  const extraHead = opts.extraHead ? `\n    ${opts.extraHead.trim()}` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${opts.title}</title>
    <link rel="stylesheet" href="${assetUrl("/gallery-v2.css")}" />${extraHead}
  </head>
  <body${bodyAttrs}>
${opts.body}
  </body>
</html>
`;
}
