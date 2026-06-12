import { esc } from "./_escape.js";

// /embed/<id> — minimal iframe-embeddable player for devlogs/portfolios.
// Deliberately bare: no chrome, no shared CSS, no scripts. Styles are
// inlined (token values copied from chrome.css :root) so the page costs
// one HTML request plus the gif. URLs stay relative — inside a foreign
// iframe they resolve against this page's own origin.

export interface EmbedView {
  drawing_id: string;
}

export default function renderEmbed(v: EmbedView): string {
  const id = esc(v.drawing_id);
  const idShort = esc(v.drawing_id.slice(0, 8));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Draw! · ${idShort}</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; flex-direction: column; background: #ffffff; }
  .art { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; padding: 8px; }
  .art img { image-rendering: pixelated; max-width: 100%; max-height: 100%; aspect-ratio: 1; border: 1px solid #e6e6e3; background: #f7f7f5; }
  .foot { flex: none; text-align: center; padding: 4px 8px 8px; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .foot a { color: #6b6b6b; text-decoration: none; }
  .foot a:hover { color: #0a0a0a; text-decoration: underline; text-decoration-color: #00ccff; }
</style>
</head>
<body>
<a class="art" href="/d/${id}" target="_top" aria-label="Open drawing ${idShort} on Draw!">
  <img src="/tiles/${id}.gif" alt="Pixel art loop ${idShort}" />
</a>
<p class="foot"><a href="/" target="_top">Made with Draw!</a></p>
</body>
</html>
`;
}
