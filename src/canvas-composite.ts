import { WIDTH, HEIGHT } from "../config/constants.js";
import { Bitmap } from "./editor/bitmap.js";
import { decodeGif } from "./editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "./editor/palette.js";

// Flattens a multi-tile canvas into a SQUARE, letterboxed stack of Bitmap
// frames so the existing single-image merch pipeline (preview + SVG upscale)
// works unchanged: both treat the design as one square N×N bitmap. The side is
// max(cols, rows) tiles; a non-square canvas is centered with transparent
// margins (which print as no ink). Shorter tiles loop within the longest tile's
// frame count.
//
// Palette assumption: every tile in an editor-published canvas shares ONE
// activePalette (src/submit.ts encodes all cells with the same palette), so the
// composite reuses the first tile's palette and places raw slot values. A
// hand-assembled canvas mixing tiles with different palettes would render with
// the first tile's colours — an accepted v1 limitation.

export interface CompositeTile {
  x: number; // 0-based column
  y: number; // 0-based row
  gif: Uint8Array;
}

export interface CanvasComposite {
  frames: Bitmap[];
  activePalette: Uint8Array;
  side: number; // tiles per side of the square composite
}

export function buildCanvasComposite(
  tiles: CompositeTile[],
  cols: number,
  rows: number,
): CanvasComposite {
  const side = Math.max(cols, rows);
  const sizePx = side * WIDTH; // square: side*16 × side*16
  const offCols = Math.floor((side - cols) / 2);
  const offRows = Math.floor((side - rows) / 2);

  const decoded = tiles.map((t) => ({ x: t.x, y: t.y, ...decodeGif(t.gif) }));
  const activePalette =
    decoded.find((d) => d.activePalette)?.activePalette ??
    new Uint8Array(DEFAULT_ACTIVE_PALETTE);
  const frameCount = Math.max(1, ...decoded.map((d) => d.frames.length));

  const frames: Bitmap[] = [];
  for (let f = 0; f < frameCount; f++) {
    const bmp = new Bitmap(sizePx, sizePx); // zero-filled = all TRANSPARENT
    for (const d of decoded) {
      const frame = d.frames[f % d.frames.length];
      const ox = (offCols + d.x) * WIDTH;
      const oy = (offRows + d.y) * HEIGHT;
      for (let py = 0; py < HEIGHT; py++) {
        for (let px = 0; px < WIDTH; px++) {
          bmp.set(ox + px, oy + py, frame.get(px, py));
        }
      }
    }
    frames.push(bmp);
  }

  return { frames, activePalette, side };
}
