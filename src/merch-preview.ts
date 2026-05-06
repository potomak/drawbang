import { WIDTH, HEIGHT, FRAME_DELAY_MS } from "../config/constants.js";
import { Bitmap, TRANSPARENT } from "./editor/bitmap.js";
import type { RGB } from "./editor/palette.js";

// Composites the user's 16×16 drawing into a base product mockup PNG. Used
// on /merch?d=<id> to preview what the merch will look like with the
// drawing applied — the goal is "see it on a tee in <100ms, no network"
// per #93. Animated multi-frame drawings loop at the editor's 200 ms
// cadence; single-frame drawings are static.

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
  placeholder: PlaceholderRect;
}

export interface PreviewInput {
  canvas: HTMLCanvasElement;
  mockup: HTMLImageElement;
  config: MockupConfig;
  frames: Bitmap[];
  palette: readonly RGB[];
  startFrame?: number;
  delayMs?: number;
}

export interface PreviewController {
  setFrames(frames: Bitmap[], palette: readonly RGB[]): void;
  setActiveFrame(idx: number): void;
  stop(): void;
}

export function renderMockupPreview(input: PreviewInput): PreviewController {
  const { canvas, mockup, config } = input;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("renderMockupPreview: 2d context unavailable");

  // Cap the canvas at the mockup's natural pixel dims so 1 mockup px == 1
  // canvas px, which keeps `drawImage` deterministic and the composite math
  // legible. CSS scales it down to fit the layout.
  canvas.width = config.mockup_width;
  canvas.height = config.mockup_height;

  // The print area sits in mockup-pixel space; we render the upscaled
  // drawing to an offscreen canvas at print-area dims, then drawImage that
  // onto the main canvas. Offscreen sizing keeps `imageSmoothingEnabled =
  // false` honoured by the browser regardless of CSS scaling.
  const offscreen = document.createElement("canvas");
  offscreen.width = config.placeholder.width;
  offscreen.height = config.placeholder.height;
  const offCtx = offscreen.getContext("2d");
  if (!offCtx) throw new Error("renderMockupPreview: offscreen 2d unavailable");

  let frames = input.frames;
  let palette = input.palette;
  let activeIdx = clampFrame(input.startFrame ?? 0, frames.length);
  let timer: ReturnType<typeof setInterval> | null = null;

  function paintFrame(): void {
    ctx!.clearRect(0, 0, canvas.width, canvas.height);
    ctx!.drawImage(mockup, 0, 0, canvas.width, canvas.height);
    drawBitmapInto(offCtx!, frames[activeIdx], palette, offscreen.width, offscreen.height);
    ctx!.drawImage(
      offscreen,
      config.placeholder.x,
      config.placeholder.y,
      config.placeholder.width,
      config.placeholder.height,
    );
  }

  function startAnimation(): void {
    stopAnimation();
    if (frames.length <= 1) return;
    const delay = input.delayMs ?? FRAME_DELAY_MS;
    timer = setInterval(() => {
      activeIdx = (activeIdx + 1) % frames.length;
      paintFrame();
    }, delay);
  }

  function stopAnimation(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  paintFrame();
  startAnimation();

  return {
    setFrames(nextFrames, nextPalette) {
      frames = nextFrames;
      palette = nextPalette;
      activeIdx = clampFrame(activeIdx, frames.length);
      paintFrame();
      startAnimation();
    },
    setActiveFrame(idx) {
      activeIdx = clampFrame(idx, frames.length);
      paintFrame();
    },
    stop: stopAnimation,
  };
}

function clampFrame(idx: number, count: number): number {
  if (count <= 0) return 0;
  if (idx < 0) return 0;
  if (idx >= count) return count - 1;
  return idx;
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
      // isn't an integer (e.g. 240/16 = 15 ≠ integer for some configs).
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
