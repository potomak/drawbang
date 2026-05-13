import { WIDTH, HEIGHT } from "../config/constants.js";
import { DEFAULT_PLACEMENT, expandPlacement, type Placement } from "../merch/placement.js";
import { Bitmap, TRANSPARENT } from "./editor/bitmap.js";
import type { RGB } from "./editor/palette.js";

// Composites the user's 16×16 drawing into a base product mockup PNG. Used
// on /merch?d=<id> to give each product card a live preview of how the
// selected frame will look on that product. One-shot — caller is expected
// to repaint when the active frame changes.

export interface PlaceholderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MockupConfig {
  mockup_url: string;
  mockup_width: number;
  mockup_height: number;
  placeholders: PlaceholderRect[];
}

export interface PaintMockupInput {
  canvas: HTMLCanvasElement;
  mockup: HTMLImageElement;
  config: MockupConfig;
  frame: Bitmap;
  palette: readonly RGB[];
  // Where (and how big) to render the drawing inside each placeholder.
  // Defaults to "full-chest" — the pre-#147 centred-letterbox behaviour.
  placement?: Placement;
}

export function paintMockupPreview(input: PaintMockupInput): void {
  const { canvas, mockup, config, frame, palette } = input;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("paintMockupPreview: 2d context unavailable");

  // Cap the canvas at the mockup's natural pixel dims so 1 mockup px == 1
  // canvas px, which keeps `drawImage` deterministic and the composite math
  // legible. CSS scales it down to fit the layout.
  canvas.width = config.mockup_width;
  canvas.height = config.mockup_height;
  ctx.imageSmoothingEnabled = false;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(mockup, 0, 0, canvas.width, canvas.height);

  // Mirror the placement math from merch/placement.ts so the preview
  // matches what Printify produces — same imageId fed to expandPlacement
  // on both sides. For named presets this is one entry per placeholder;
  // for patterns it's n² entries on an n×n grid.
  //
  // The drawing is square (16×16) but Printify print rects usually aren't.
  // Stretching distorts the artwork, so each rendered cell is a square of
  // side = scale × min(placeholder.width, placeholder.height) centred at
  // the (x, y) fraction of the placeholder. Multi-up products (sticker
  // sheets) get one set of entries per print position.
  const placement = input.placement ?? DEFAULT_PLACEMENT;
  const entries = expandPlacement(placement, "preview");

  for (const ph of config.placeholders) {
    const minDim = Math.min(ph.width, ph.height);
    for (const entry of entries) {
      const side = Math.max(1, Math.floor(minDim * entry.scale));
      const cx = ph.x + ph.width * entry.x;
      const cy = ph.y + ph.height * entry.y;
      const px = Math.floor(cx - side / 2);
      const py = Math.floor(cy - side / 2);

      const offscreen = document.createElement("canvas");
      offscreen.width = side;
      offscreen.height = side;
      const offCtx = offscreen.getContext("2d");
      if (!offCtx) throw new Error("paintMockupPreview: offscreen 2d unavailable");
      drawBitmapInto(offCtx, frame, palette, side, side);

      ctx.drawImage(offscreen, px, py, side, side);
    }
  }
}

// Pixel-perfect raster of one Bitmap into a canvas of arbitrary dims.
// Each source pixel becomes a rect of size (outW/16, outH/16) — caller is
// expected to size the offscreen so the math comes out clean.
function drawBitmapInto(
  ctx: CanvasRenderingContext2D,
  frame: Bitmap,
  palette: readonly RGB[],
  outW: number,
  outH: number,
): void {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, outW, outH);
  const cellW = outW / WIDTH;
  const cellH = outH / HEIGHT;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const v = frame.get(x, y);
      if (v === TRANSPARENT) continue;
      const [r, g, b] = palette[v];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      // Use Math.round so adjacent cells don't leave 1-px seams when cellW
      // isn't an integer.
      const px = Math.round(x * cellW);
      const py = Math.round(y * cellH);
      const pw = Math.round((x + 1) * cellW) - px;
      const ph = Math.round((y + 1) * cellH) - py;
      ctx.fillRect(px, py, pw, ph);
    }
  }
}

// Cache so we only fetch each base mockup once per page load.
const mockupCache = new Map<string, Promise<HTMLImageElement>>();

export function loadMockupImage(url: string): Promise<HTMLImageElement> {
  let cached = mockupCache.get(url);
  if (cached) return cached;
  cached = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load mockup ${url}`));
    img.src = url;
  });
  mockupCache.set(url, cached);
  return cached;
}
