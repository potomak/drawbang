import {
  ACTIVE_PALETTE_SIZE,
  DRAWBANG_APP_AUTH_CODE,
  DRAWBANG_APP_IDENTIFIER,
  FRAME_DELAY_MS,
  HEIGHT,
  MAX_FRAMES,
  WIDTH,
} from "../../config/constants.js";
import { Bitmap, TRANSPARENT } from "./bitmap.js";
import { activePaletteToRgb } from "./palette.js";

// @ts-expect-error omggif ships no TS types
import { GifWriter, GifReader } from "omggif";

// Pixels are 0..15 (active palette slot) or 16 (transparent). GIF palettes
// must be power-of-two sized, so we pad the GCT to 32 entries: slots 0..15
// hold the active-palette colors, slot 16 is the transparent placeholder
// (GCE marks it invisible), 17..31 are zeros and never referenced.
const GCT_SIZE = 32;
const TRANSPARENT_INDEX = TRANSPARENT; // 16

export interface EncodeInput {
  frames: Bitmap[];
  activePalette: Uint8Array; // length ACTIVE_PALETTE_SIZE, base-palette indices
  delayMs?: number;
}

export interface DecodeResult {
  frames: Bitmap[];
  activePalette: Uint8Array | null; // null if the GIF lacks a DRAWBANG extension
  delayMs: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("ascii");

function buildGctInts(activePalette: Uint8Array): number[] {
  const rgb = activePaletteToRgb(activePalette);
  const gct = new Array<number>(GCT_SIZE).fill(0);
  for (let i = 0; i < ACTIVE_PALETTE_SIZE; i++) {
    const [r, g, b] = rgb[i];
    gct[i] = (r << 16) | (g << 8) | b;
  }
  return gct;
}

function toGifDelay(ms: number): number {
  return Math.max(1, Math.round(ms / 10));
}

export function encodeGif({ frames, activePalette, delayMs = FRAME_DELAY_MS }: EncodeInput): Uint8Array {
  if (frames.length === 0) throw new Error("encodeGif: no frames");
  if (frames.length > MAX_FRAMES) throw new Error(`encodeGif: too many frames (${frames.length})`);
  if (activePalette.length !== ACTIVE_PALETTE_SIZE) {
    throw new Error(`encodeGif: active palette must be ${ACTIVE_PALETTE_SIZE} bytes`);
  }

  const gct = buildGctInts(activePalette);
  const buf = new Uint8Array(64 * 1024);
  const writer = new GifWriter(buf, WIDTH, HEIGHT, {
    palette: gct,
    loop: frames.length > 1 ? 0 : undefined,
  });

  const delay = toGifDelay(delayMs);
  for (const frame of frames) {
    if (frame.width !== WIDTH || frame.height !== HEIGHT) {
      throw new Error(`encodeGif: frame ${frame.width}x${frame.height} != ${WIDTH}x${HEIGHT}`);
    }
    writer.addFrame(0, 0, WIDTH, HEIGHT, frame.data, {
      delay,
      transparent: TRANSPARENT_INDEX,
      disposal: 2,
    });
  }

  const written = writer.end();
  return spliceDrawbangExtension(buf.subarray(0, written), activePalette);
}

export function decodeGif(bytes: Uint8Array): DecodeResult {
  const reader = new GifReader(bytes) as any;
  const count: number = reader.numFrames();
  if (count === 0) throw new Error("decodeGif: no frames");
  if (count > MAX_FRAMES) throw new Error(`decodeGif: too many frames (${count})`);
  if (reader.width !== WIDTH || reader.height !== HEIGHT) {
    throw new Error(`decodeGif: expected ${WIDTH}x${HEIGHT}, got ${reader.width}x${reader.height}`);
  }

  // Build an RGB -> active-palette-slot lookup from the active palette
  // embedded in the GIF. If the DRAWBANG extension is present use it; otherwise
  // fall back to mapping "raw GCT colors" to their position. Either way a
  // foreign/transparent pixel becomes TRANSPARENT_INDEX.
  const activePalette = findDrawbangExtension(bytes);
  const colorToSlot = buildColorToSlot(activePalette);

  const frames: Bitmap[] = [];
  let delayMs = FRAME_DELAY_MS;
  for (let i = 0; i < count; i++) {
    const info = reader.frameInfo(i);
    if (i === 0 && info.delay) delayMs = info.delay * 10;

    const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
    reader.decodeAndBlitFrameRGBA(i, rgba);
    const indices = new Uint8Array(WIDTH * HEIGHT).fill(TRANSPARENT_INDEX);
    for (let p = 0, q = 0; p < rgba.length; p += 4, q++) {
      if (rgba[p + 3] === 0) continue; // alpha zero → transparent
      const key = (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2];
      const slot = colorToSlot.get(key);
      indices[q] = slot ?? 0;
    }
    frames.push(new Bitmap(WIDTH, HEIGHT, indices));
  }

  return { frames, activePalette, delayMs };
}

function buildColorToSlot(activePalette: Uint8Array | null): Map<number, number> {
  const map = new Map<number, number>();
  if (!activePalette) return map;
  // Collisions (two slots sharing an RGB) are resolved by "first wins" which
  // matches the natural order when the editor later re-encodes.
  const rgb = activePaletteToRgb(activePalette);
  for (let i = 0; i < ACTIVE_PALETTE_SIZE; i++) {
    const [r, g, b] = rgb[i];
    const key = (r << 16) | (g << 8) | b;
    if (!map.has(key)) map.set(key, i);
  }
  return map;
}

function spliceDrawbangExtension(gif: Uint8Array, activePalette: Uint8Array): Uint8Array {
  if (gif[gif.length - 1] !== 0x3b) {
    throw new Error("spliceDrawbangExtension: GIF trailer (0x3B) not found");
  }
  const ext = buildDrawbangExtension(activePalette);
  const out = new Uint8Array(gif.length - 1 + ext.length + 1);
  out.set(gif.subarray(0, gif.length - 1), 0);
  out.set(ext, gif.length - 1);
  out[out.length - 1] = 0x3b;
  return out;
}

// GIF89a Application Extension carrying our 16 base-palette indices.
//   0x21 0xFF 0x0B <8-byte id> <3-byte auth> <sub-block: size=16, data> 0x00
function buildDrawbangExtension(activePalette: Uint8Array): Uint8Array {
  const ident = textEncoder.encode(DRAWBANG_APP_IDENTIFIER);
  if (ident.length !== 8) throw new Error("DRAWBANG identifier must be 8 bytes");
  if (DRAWBANG_APP_AUTH_CODE.length !== 3) throw new Error("auth code must be 3 bytes");

  const out = new Uint8Array(3 + 8 + 3 + 1 + ACTIVE_PALETTE_SIZE + 1);
  let p = 0;
  out[p++] = 0x21;
  out[p++] = 0xff;
  out[p++] = 0x0b;
  out.set(ident, p); p += 8;
  out.set(DRAWBANG_APP_AUTH_CODE, p); p += 3;
  out[p++] = ACTIVE_PALETTE_SIZE;
  out.set(activePalette, p); p += ACTIVE_PALETTE_SIZE;
  out[p++] = 0x00;
  return out;
}

function findDrawbangExtension(gif: Uint8Array): Uint8Array | null {
  if (gif.length < 13) return null;
  if (textDecoder.decode(gif.subarray(0, 6)) !== "GIF89a") return null;

  let p = 6;
  const packed = gif[p + 4];
  p += 7;
  if (packed & 0x80) {
    const gctSize = 1 << ((packed & 0x07) + 1);
    p += gctSize * 3;
  }

  while (p < gif.length) {
    const marker = gif[p];
    if (marker === 0x3b) return null;
    if (marker === 0x21) {
      p++;
      const label = gif[p++];
      if (label === 0xff) {
        const blockSize = gif[p++];
        if (blockSize !== 0x0b) {
          p = skipSubBlocks(gif, p);
          continue;
        }
        const ident = textDecoder.decode(gif.subarray(p, p + 8));
        p += 8;
        p += 3;
        if (ident === DRAWBANG_APP_IDENTIFIER) {
          const subSize = gif[p++];
          if (subSize !== ACTIVE_PALETTE_SIZE) return null;
          return gif.slice(p, p + subSize);
        }
        p = skipSubBlocks(gif, p);
      } else {
        const size = gif[p++];
        p += size;
        p = skipSubBlocks(gif, p);
      }
    } else if (marker === 0x2c) {
      p++;
      p += 8;
      const imgPacked = gif[p++];
      if (imgPacked & 0x80) {
        const lctSize = 1 << ((imgPacked & 0x07) + 1);
        p += lctSize * 3;
      }
      p++;
      p = skipSubBlocks(gif, p);
    } else {
      return null;
    }
  }
  return null;
}

function skipSubBlocks(gif: Uint8Array, p: number): number {
  while (p < gif.length) {
    const size = gif[p++];
    if (size === 0) break;
    p += size;
  }
  return p;
}
