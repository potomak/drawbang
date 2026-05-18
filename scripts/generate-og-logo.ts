// One-shot generator: turn src/layout/logo.ts's 42×16 SVG wordmark into a
// 320×320 high-contrast PNG suitable for use as an og:image. Run via:
//
//   npm run og:logo
//
// Re-run when LOGO_SVG changes; commit the resulting static/og-logo.png.
// Kept as a maintenance script (not part of `npm run build`) so the Vite
// build stays unaware of the native @resvg/resvg-js binary.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { LOGO_SVG } from "../src/layout/logo.js";

// Theme tokens lifted from static/chrome.css :root — keep these two in
// sync if the dark theme ever shifts. White-on-near-black for max
// contrast on any preview surface.
const BG = "#0a0a0a";
const FG = "#f0ece4";

const OUT_SIZE = 320;
const LOGO_W = 42;
const LOGO_H = 16;
const SCALE = 7;            // wordmark renders at 294×112 inside the 320 frame
const LOGO_SCALED_W = LOGO_W * SCALE;
const LOGO_SCALED_H = LOGO_H * SCALE;
const X = (OUT_SIZE - LOGO_SCALED_W) / 2;   // 13
const Y = (OUT_SIZE - LOGO_SCALED_H) / 2;   // 104

// Tint the wordmark by substituting the currentColor binding. The inner
// SVG is then placed inside an outer 320×320 SVG with the background
// rect drawn first.
const tintedInner = LOGO_SVG.replace(`fill="currentColor"`, `fill="${FG}"`);

const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUT_SIZE}" height="${OUT_SIZE}" viewBox="0 0 ${OUT_SIZE} ${OUT_SIZE}">
  <rect x="0" y="0" width="${OUT_SIZE}" height="${OUT_SIZE}" fill="${BG}"/>
  <g transform="translate(${X} ${Y}) scale(${SCALE})">${tintedInner}</g>
</svg>`;

const resvg = new Resvg(wrapped, {
  fitTo: { mode: "width", value: OUT_SIZE },
  // Disable image-rendering smoothing: the wordmark is a pixel-aligned
  // glyph grid, so nearest-neighbor preserves the intended look.
  shapeRendering: 2, // crispEdges
});
const png = resvg.render().asPng();

const outPath = resolve(import.meta.dirname, "..", "static", "og-logo.png");
writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${png.length} bytes, ${OUT_SIZE}×${OUT_SIZE})`);
