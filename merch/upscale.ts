import { Bitmap, TRANSPARENT } from "../src/editor/bitmap.js";
import { activePaletteToRgb } from "../src/editor/palette.js";

export interface UpscaleOptions {
  sizePx: number;
  background?: [number, number, number] | null;
}

// Emit a 16×16 pixel-art bitmap as an SVG sized to `sizePx × sizePx`. Each
// non-transparent source pixel becomes one `<rect width="1" height="1">`
// inside a `0 0 16 16` viewBox; `shape-rendering="crispEdges"` keeps the
// pixel-art look at any rasterization scale Printify ends up choosing.
//
// Compared to the old PNG path this scales to print-area sizes (≥4000 px
// per side) without allocating a full-resolution RGBA buffer — the output
// is bounded by 16×16 = 256 rects regardless of `sizePx`. Memory usage is
// O(rects), not O(pixels).
export function upscaleBitmapToSvg(
  bitmap: Bitmap,
  activePalette: Uint8Array,
  opts: UpscaleOptions,
): Uint8Array {
  const { sizePx } = opts;
  const background = opts.background ?? null;

  if (!Number.isInteger(sizePx) || sizePx <= 0) {
    throw new Error(`sizePx must be a positive integer, got ${sizePx}`);
  }
  if (sizePx % bitmap.width !== 0 || sizePx % bitmap.height !== 0) {
    throw new Error(
      `sizePx (${sizePx}) must be a multiple of bitmap dims (${bitmap.width}x${bitmap.height})`,
    );
  }

  const colors = activePaletteToRgb(activePalette);
  const W = bitmap.width;
  const H = bitmap.height;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">`,
  );
  if (background !== null) {
    parts.push(`<rect width="${W}" height="${H}" fill="${rgbHex(background)}"/>`);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = bitmap.get(x, y);
      if (idx === TRANSPARENT) continue;
      const fill = rgbHex(colors[idx]);
      parts.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`);
    }
  }
  parts.push(`</svg>`);
  return new TextEncoder().encode(parts.join(""));
}

function rgbHex([r, g, b]: readonly [number, number, number]): string {
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function hex(n: number): string {
  return n.toString(16).padStart(2, "0");
}
