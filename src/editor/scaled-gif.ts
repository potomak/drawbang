import {
  ACTIVE_PALETTE_SIZE,
  FRAME_DELAY_MS,
  HEIGHT,
  MAX_FRAMES,
  WIDTH,
} from "../../config/constants.js";
import { Bitmap, TRANSPARENT } from "./bitmap.js";
import { activePaletteToRgb } from "./palette.js";

// @ts-expect-error omggif ships no TS types
import { GifWriter } from "omggif";

// Standalone upscaler that emits a non-Drawbang GIF at integer-scaled
// dimensions. Used by the social-share flow (#62) so 16×16 art doesn't
// render as a postage stamp on Reddit / Twitter / etc. The output GIF is
// not editable by the editor (no DRAWBANG application extension); it's
// strictly a download artifact.

const GCT_SIZE = 32;
const TRANSPARENT_INDEX = TRANSPARENT;

export interface EncodeScaledInput {
  frames: Bitmap[];
  activePalette: Uint8Array;
  scale: number;
  delayMs?: number;
}

export function encodeScaledGif({
  frames,
  activePalette,
  scale,
  delayMs = FRAME_DELAY_MS,
}: EncodeScaledInput): Uint8Array {
  if (frames.length === 0) throw new Error("encodeScaledGif: no frames");
  if (frames.length > MAX_FRAMES) {
    throw new Error(`encodeScaledGif: too many frames (${frames.length})`);
  }
  if (activePalette.length !== ACTIVE_PALETTE_SIZE) {
    throw new Error(`encodeScaledGif: active palette must be ${ACTIVE_PALETTE_SIZE} bytes`);
  }
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`encodeScaledGif: scale must be a positive integer (got ${scale})`);
  }

  const outW = WIDTH * scale;
  const outH = HEIGHT * scale;
  const gct = buildGctInts(activePalette);

  // Worst case: every cell has its own LZW code. ~outW*outH bytes per frame
  // plus per-frame headers. Bounded buffer is fine — the encoder fails fast
  // if it runs out, which we want to surface during dev.
  const buf = new Uint8Array(outW * outH * frames.length + 4096);
  const writer = new GifWriter(buf, outW, outH, {
    palette: gct,
    loop: frames.length > 1 ? 0 : undefined,
  });

  const delay = Math.max(1, Math.round(delayMs / 10));
  for (const frame of frames) {
    if (frame.width !== WIDTH || frame.height !== HEIGHT) {
      throw new Error(
        `encodeScaledGif: frame ${frame.width}x${frame.height} != ${WIDTH}x${HEIGHT}`,
      );
    }
    writer.addFrame(0, 0, outW, outH, scaleFrame(frame, scale, outW, outH), {
      delay,
      transparent: TRANSPARENT_INDEX,
      disposal: 2,
    });
  }
  return buf.subarray(0, writer.end());
}

function scaleFrame(frame: Bitmap, scale: number, outW: number, outH: number): Uint8Array {
  const out = new Uint8Array(outW * outH);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const slot = frame.data[y * WIDTH + x];
      // Replicate this source cell as a `scale × scale` block.
      for (let dy = 0; dy < scale; dy++) {
        const rowStart = (y * scale + dy) * outW + x * scale;
        for (let dx = 0; dx < scale; dx++) {
          out[rowStart + dx] = slot;
        }
      }
    }
  }
  return out;
}

function buildGctInts(activePalette: Uint8Array): number[] {
  const rgb = activePaletteToRgb(activePalette);
  const gct = new Array<number>(GCT_SIZE).fill(0);
  for (let i = 0; i < ACTIVE_PALETTE_SIZE; i++) {
    const [r, g, b] = rgb[i];
    gct[i] = (r << 16) | (g << 8) | b;
  }
  return gct;
}
