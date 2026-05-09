import type { PrintifyClient } from "./printify.js";

// 5×7 pixel font for the brand wordmark. Hand-laid so the rasterised
// output matches the editor's pixel-art aesthetic — anti-aliasing the
// fabric print would smear it. Only the glyphs we ship in the wordmark
// live here; if the wordmark ever grows beyond DRAW! add more.
//
// Dot = transparent, hash = filled.
const FONT: Record<string, readonly string[]> = {
  D: [
    "####.",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    "####.",
  ],
  R: [
    "####.",
    "#...#",
    "#...#",
    "####.",
    "#.#..",
    "#..#.",
    "#...#",
  ],
  A: [
    ".###.",
    "#...#",
    "#...#",
    "#####",
    "#...#",
    "#...#",
    "#...#",
  ],
  W: [
    "#...#",
    "#...#",
    "#...#",
    "#...#",
    "#.#.#",
    "##.##",
    "#...#",
  ],
  "!": [
    "#",
    "#",
    "#",
    "#",
    "#",
    ".",
    "#",
  ],
};

const WORD = "DRAW!";
const ROWS = 7;
// One blank cell between glyphs.
const KERNING = 1;
// One source cell renders as this many output pixels. ~20 keeps the
// wordmark legible (~500 px wide) while still letterboxing comfortably
// inside the 750×750 neck placeholder Printify exposes for blueprint 6.
const CELL_PX = 20;

// Build the SVG bytes. Pure function; the upload + cache is in
// `createBrandLogoProvider`. Exported for unit testing.
export function buildBrandLogoSvg(): Uint8Array {
  let cursorX = 0;
  let totalCols = 0;
  for (let i = 0; i < WORD.length; i++) {
    const ch = WORD[i];
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`brand logo: glyph not in FONT: "${ch}"`);
    totalCols += glyph[0].length + (i < WORD.length - 1 ? KERNING : 0);
  }
  const rects: string[] = [];
  for (const ch of WORD) {
    const glyph = FONT[ch]!;
    const w = glyph[0].length;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < w; x++) {
        if (glyph[y][x] === "#") {
          rects.push(`<rect x="${cursorX + x}" y="${y}" width="1" height="1"/>`);
        }
      }
    }
    cursorX += w + KERNING;
  }
  const widthPx = totalCols * CELL_PX;
  const heightPx = ROWS * CELL_PX;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${widthPx}" height="${heightPx}" ` +
    `viewBox="0 0 ${totalCols} ${ROWS}" ` +
    `shape-rendering="crispEdges" fill="black">` +
    rects.join("") +
    `</svg>`;
  return new TextEncoder().encode(svg);
}

export interface BrandLogoProvider {
  /**
   * Returns the Printify image id for the brand wordmark, uploading on
   * first call and caching the result for the lifetime of the provider
   * (typically a Lambda container).
   */
  getImageId(): Promise<string>;
}

// One module-level cache per provider instance. The Lambda creates one
// provider at boot (`merch/lambda.ts`) and reuses it across warm
// invocations — so the SVG is uploaded exactly once per cold start.
// Tests pass their own provider stub via PlacePrintifyOrderDeps.
export function createBrandLogoProvider(client: PrintifyClient): BrandLogoProvider {
  let cached: string | null = null;
  let inFlight: Promise<string> | null = null;
  return {
    async getImageId() {
      if (cached) return cached;
      // Coalesce concurrent first-callers onto the same upload promise so
      // we don't double-upload when two orders dispatch back-to-back on a
      // cold container.
      if (inFlight) return inFlight;
      inFlight = (async () => {
        const bytes = buildBrandLogoSvg();
        const upload = await client.uploadImage("drawbang-brand-logo.svg", bytes);
        cached = upload.id;
        return cached;
      })();
      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    },
  };
}
