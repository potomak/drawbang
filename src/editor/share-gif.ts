import {
  ACTIVE_PALETTE_SIZE,
  FRAME_DELAY_MS,
  HEIGHT,
  MAX_FRAMES,
  WIDTH,
} from "../../config/constants.js";
import { LOGO_BITMAP, LOGO_H, LOGO_W } from "../layout/logo-bitmap.js";
import { Bitmap, TRANSPARENT } from "./bitmap.js";
import { activePaletteToRgb, type RGB } from "./palette.js";

// @ts-expect-error omggif ships no TS types
import { GifWriter } from "omggif";

// 320×320 share image: the source 16×16 art upscaled 14× and inset on a
// derived background, with a used-colors palette swatch top-left and the
// Drawbang wordmark bottom-right. Used as og:image on every drawing page.
// Output is a plain GIF (no DRAWBANG extension) — not editable, strictly
// a social preview artifact. See #195.

export const SHARE_W = 320;
export const SHARE_H = 320;
const ART_SCALE = 14;
const ART_W = WIDTH * ART_SCALE; // 224
const ART_H = HEIGHT * ART_SCALE; // 224
const ART_X = (SHARE_W - ART_W) / 2; // 48
const ART_Y = (SHARE_H - ART_H) / 2; // 48

const SWATCH_X = 8;
const SWATCH_Y = 8;
const SWATCH_SIZE = 6;
const SWATCH_GUTTER = 1;
const SWATCH_COLS = 8;

const LOGO_X = SHARE_W - LOGO_W - 8; // 270
const LOGO_Y = SHARE_H - LOGO_H - 8; // 296

const GCT_SIZE = 32;
const BG_SLOT = 17;
const FG_SLOT = 18;
const TRANSPARENT_INDEX = TRANSPARENT; // 16 — preserved for parity with gif.ts

const FALLBACK_BG: RGB = [40, 50, 60];
const FALLBACK_FG: RGB = [240, 240, 240];
const BG_FLOOR: RGB = [24, 24, 24];

export interface EncodeShareInput {
  frames: Bitmap[];
  activePalette: Uint8Array;
  delayMs?: number;
}

export function encodeShareGif({
  frames,
  activePalette,
  delayMs = FRAME_DELAY_MS,
}: EncodeShareInput): Uint8Array {
  if (frames.length === 0) throw new Error("encodeShareGif: no frames");
  if (frames.length > MAX_FRAMES) {
    throw new Error(`encodeShareGif: too many frames (${frames.length})`);
  }
  if (activePalette.length !== ACTIVE_PALETTE_SIZE) {
    throw new Error(`encodeShareGif: active palette must be ${ACTIVE_PALETTE_SIZE} bytes`);
  }

  const paletteRgb = activePaletteToRgb(activePalette);
  const usage = countUsage(frames);
  const usedSlots: number[] = [];
  for (let i = 0; i < ACTIVE_PALETTE_SIZE; i++) {
    if (usage[i] > 0) usedSlots.push(i);
  }

  const { bg, fg } = deriveColors(paletteRgb, usage, usedSlots);

  const gct = buildGct(paletteRgb, bg, fg);

  const chrome = buildChromeLayer(usedSlots);

  // Worst case for LZW: roughly one byte per pixel. Headroom for headers.
  const buf = new Uint8Array(SHARE_W * SHARE_H * frames.length + 8192);
  const writer = new GifWriter(buf, SHARE_W, SHARE_H, {
    palette: gct,
    loop: frames.length > 1 ? 0 : undefined,
  });

  const delay = Math.max(1, Math.round(delayMs / 10));
  for (const frame of frames) {
    if (frame.width !== WIDTH || frame.height !== HEIGHT) {
      throw new Error(
        `encodeShareGif: frame ${frame.width}x${frame.height} != ${WIDTH}x${HEIGHT}`,
      );
    }
    const composed = composeFrame(chrome, frame);
    writer.addFrame(0, 0, SHARE_W, SHARE_H, composed, {
      delay,
      transparent: TRANSPARENT_INDEX,
      disposal: 2,
    });
  }
  return buf.subarray(0, writer.end());
}

function countUsage(frames: Bitmap[]): Uint32Array {
  const counts = new Uint32Array(ACTIVE_PALETTE_SIZE);
  for (const f of frames) {
    for (const slot of f.data) {
      if (slot < ACTIVE_PALETTE_SIZE) counts[slot]++;
    }
  }
  return counts;
}

function deriveColors(
  paletteRgb: RGB[],
  usage: Uint32Array,
  usedSlots: number[],
): { bg: RGB; fg: RGB } {
  if (usedSlots.length === 0) {
    return { bg: FALLBACK_BG, fg: FALLBACK_FG };
  }

  let dominant = usedSlots[0];
  for (const s of usedSlots) {
    if (usage[s] > usage[dominant]) dominant = s;
  }
  const [dr, dg, db] = paletteRgb[dominant];
  const bg: RGB = [
    Math.max(BG_FLOOR[0], Math.round(dr * 0.45)),
    Math.max(BG_FLOOR[1], Math.round(dg * 0.45)),
    Math.max(BG_FLOOR[2], Math.round(db * 0.45)),
  ];

  let lightest = usedSlots[0];
  let lightestSum = sumRgb(paletteRgb[lightest]);
  for (const s of usedSlots) {
    const sum = sumRgb(paletteRgb[s]);
    if (sum > lightestSum) {
      lightest = s;
      lightestSum = sum;
    }
  }
  const fg: RGB = lightestSum < 600 ? FALLBACK_FG : paletteRgb[lightest];

  return { bg, fg };
}

function sumRgb([r, g, b]: RGB): number {
  return r + g + b;
}

function buildGct(paletteRgb: RGB[], bg: RGB, fg: RGB): number[] {
  const gct = new Array<number>(GCT_SIZE).fill(0);
  for (let i = 0; i < ACTIVE_PALETTE_SIZE; i++) {
    gct[i] = rgbToInt(paletteRgb[i]);
  }
  gct[BG_SLOT] = rgbToInt(bg);
  gct[FG_SLOT] = rgbToInt(fg);
  return gct;
}

function rgbToInt([r, g, b]: RGB): number {
  return (r << 16) | (g << 8) | b;
}

function buildChromeLayer(usedSlots: number[]): Uint8Array {
  const buf = new Uint8Array(SHARE_W * SHARE_H).fill(BG_SLOT);

  if (usedSlots.length > 0) {
    paintSwatch(buf, usedSlots);
  }
  paintLogo(buf);

  return buf;
}

function paintSwatch(buf: Uint8Array, usedSlots: number[]): void {
  const cols = Math.min(SWATCH_COLS, usedSlots.length);
  const rows = Math.ceil(usedSlots.length / SWATCH_COLS);
  const blockW = cols * (SWATCH_SIZE + SWATCH_GUTTER) - SWATCH_GUTTER;
  const blockH = rows * (SWATCH_SIZE + SWATCH_GUTTER) - SWATCH_GUTTER;

  // 1px foreground border around the block.
  fillRect(buf, SWATCH_X - 1, SWATCH_Y - 1, blockW + 2, 1, FG_SLOT);
  fillRect(buf, SWATCH_X - 1, SWATCH_Y + blockH, blockW + 2, 1, FG_SLOT);
  fillRect(buf, SWATCH_X - 1, SWATCH_Y, 1, blockH, FG_SLOT);
  fillRect(buf, SWATCH_X + blockW, SWATCH_Y, 1, blockH, FG_SLOT);

  usedSlots.forEach((slot, i) => {
    const col = i % SWATCH_COLS;
    const row = Math.floor(i / SWATCH_COLS);
    const x = SWATCH_X + col * (SWATCH_SIZE + SWATCH_GUTTER);
    const y = SWATCH_Y + row * (SWATCH_SIZE + SWATCH_GUTTER);
    fillRect(buf, x, y, SWATCH_SIZE, SWATCH_SIZE, slot);
  });
}

function paintLogo(buf: Uint8Array): void {
  for (let y = 0; y < LOGO_H; y++) {
    for (let x = 0; x < LOGO_W; x++) {
      if (LOGO_BITMAP[y * LOGO_W + x]) {
        buf[(LOGO_Y + y) * SHARE_W + (LOGO_X + x)] = FG_SLOT;
      }
    }
  }
}

function fillRect(buf: Uint8Array, x: number, y: number, w: number, h: number, slot: number): void {
  for (let dy = 0; dy < h; dy++) {
    const rowStart = (y + dy) * SHARE_W + x;
    for (let dx = 0; dx < w; dx++) {
      buf[rowStart + dx] = slot;
    }
  }
}

function composeFrame(chrome: Uint8Array, frame: Bitmap): Uint8Array {
  const out = new Uint8Array(chrome);
  for (let sy = 0; sy < HEIGHT; sy++) {
    for (let sx = 0; sx < WIDTH; sx++) {
      const slot = frame.data[sy * WIDTH + sx];
      // Transparent source pixels show the chrome bg through, so skip them.
      if (slot === TRANSPARENT_INDEX) continue;
      const baseX = ART_X + sx * ART_SCALE;
      const baseY = ART_Y + sy * ART_SCALE;
      for (let dy = 0; dy < ART_SCALE; dy++) {
        const rowStart = (baseY + dy) * SHARE_W + baseX;
        for (let dx = 0; dx < ART_SCALE; dx++) {
          out[rowStart + dx] = slot;
        }
      }
    }
  }
  return out;
}
