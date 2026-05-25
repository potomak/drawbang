import { WIDTH, HEIGHT } from "../config/constants.js";
import { decodeGif } from "../src/editor/gif.js";
import { activePaletteToRgb } from "../src/editor/palette.js";
import { TRANSPARENT } from "../src/editor/bitmap.js";

// Compose the first frame of each tile gif into one static RGBA raster
// (cols*16 × rows*16) and encode it as a PNG. This is the canvas thumbnail /
// OG / merch preview. Animation is intentionally dropped here — the /c/ page
// renders the live per-tile gifs in a CSS grid, so each cell still animates.

export interface StitchTile {
  x: number; // 0-based column
  y: number; // 0-based row
  gif: Uint8Array;
}

// `scale` block-upscales each source pixel (nearest-neighbour) — scale=1 is the
// native cols*16 × rows*16 thumbnail; a larger scale is used for the ~960px OG
// image. Longest-side target helper below.
export async function stitchCompositePng(
  tiles: StitchTile[],
  cols: number,
  rows: number,
  scale = 1,
): Promise<Uint8Array> {
  const w = cols * WIDTH * scale;
  const h = rows * HEIGHT * scale;
  const rgba = new Uint8Array(w * h * 4); // zero-filled = fully transparent

  const plot = (x: number, y: number, c: readonly [number, number, number]) => {
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const di = ((y * scale + dy) * w + (x * scale + dx)) * 4;
        rgba[di] = c[0];
        rgba[di + 1] = c[1];
        rgba[di + 2] = c[2];
        rgba[di + 3] = 255;
      }
    }
  };

  for (const t of tiles) {
    const { frames, activePalette } = decodeGif(t.gif);
    const frame = frames[0];
    if (!activePalette) continue;
    const rgb = activePaletteToRgb(activePalette);
    const ox = t.x * WIDTH;
    const oy = t.y * HEIGHT;
    for (let py = 0; py < HEIGHT; py++) {
      for (let px = 0; px < WIDTH; px++) {
        const slot = frame.get(px, py);
        if (slot === TRANSPARENT) continue;
        const color = rgb[slot];
        if (!color) continue;
        plot(ox + px, oy + py, color);
      }
    }
  }

  const { PNG } = await import("pngjs");
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(rgba);
  return new Uint8Array(PNG.sync.write(png));
}

// Scale that brings the longest side to ~targetPx for the OG/share image.
export function ogScale(cols: number, rows: number, targetPx = 960): number {
  const longest = Math.max(cols, rows) * WIDTH;
  return Math.max(1, Math.floor(targetPx / longest));
}
