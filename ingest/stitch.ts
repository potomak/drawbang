import { WIDTH, HEIGHT, FRAME_DELAY_MS } from "../config/constants.js";
import { decodeGif } from "../src/editor/gif.js";
import { activePaletteToRgb } from "../src/editor/palette.js";
import { TRANSPARENT } from "../src/editor/bitmap.js";
// @ts-expect-error omggif ships no TS types
import { GifWriter } from "omggif";

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

// Animated composite: stitches the tiles' frames into one (cols*16 × rows*16)
// GIF (5fps, looping; shorter tiles loop within the longest tile's length).
// Editor-published canvases share one ≤16-colour palette, so the merged GCT
// fits comfortably; returns null if a canvas ever exceeds 255 distinct colours
// (caller falls back to the static PNG).
export async function stitchCompositeGif(
  tiles: StitchTile[],
  cols: number,
  rows: number,
): Promise<Uint8Array | null> {
  const w = cols * WIDTH;
  const h = rows * HEIGHT;

  const decoded = tiles.map((t) => {
    const { frames, activePalette } = decodeGif(t.gif);
    return {
      x: t.x,
      y: t.y,
      frames,
      rgb: activePalette ? activePaletteToRgb(activePalette) : null,
    };
  });

  // Merge distinct colours into a single palette; transparent gets the slot
  // right after the colours.
  const colorToIdx = new Map<number, number>();
  const colors: number[] = [];
  for (const t of decoded) {
    if (!t.rgb) continue;
    for (const frame of t.frames) {
      for (const slot of frame.data) {
        if (slot === TRANSPARENT) continue;
        const c = t.rgb[slot];
        if (!c) continue;
        const key = (c[0] << 16) | (c[1] << 8) | c[2];
        if (!colorToIdx.has(key)) {
          colorToIdx.set(key, colors.length);
          colors.push(key);
        }
      }
    }
  }
  if (colors.length > 255) return null; // overflow → caller uses static PNG

  const transparentIdx = colors.length;
  let gctSize = 2;
  while (gctSize < colors.length + 1) gctSize *= 2;
  const gct = new Array<number>(gctSize).fill(0);
  for (let i = 0; i < colors.length; i++) gct[i] = colors[i];

  const frameCount = Math.max(1, ...decoded.map((t) => t.frames.length));
  const buf = new Uint8Array(w * h * frameCount * 2 + 8192);
  const writer = new GifWriter(buf, w, h, {
    palette: gct,
    loop: frameCount > 1 ? 0 : undefined,
  });
  const delay = Math.max(1, Math.round(FRAME_DELAY_MS / 10));

  for (let f = 0; f < frameCount; f++) {
    const idx = new Uint8Array(w * h).fill(transparentIdx);
    for (const t of decoded) {
      if (!t.rgb) continue;
      const frame = t.frames[f % t.frames.length];
      const ox = t.x * WIDTH;
      const oy = t.y * HEIGHT;
      for (let py = 0; py < HEIGHT; py++) {
        for (let px = 0; px < WIDTH; px++) {
          const slot = frame.get(px, py);
          if (slot === TRANSPARENT) continue;
          const c = t.rgb[slot];
          if (!c) continue;
          const key = (c[0] << 16) | (c[1] << 8) | c[2];
          idx[(oy + py) * w + (ox + px)] = colorToIdx.get(key)!;
        }
      }
    }
    writer.addFrame(0, 0, w, h, idx, { delay, transparent: transparentIdx, disposal: 2 });
  }

  return buf.subarray(0, writer.end());
}
