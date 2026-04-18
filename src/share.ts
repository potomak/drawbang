import { ACTIVE_PALETTE_SIZE, HEIGHT, MAX_FRAMES, WIDTH } from "../config/constants.js";
import { Bitmap, TRANSPARENT } from "./editor/bitmap.js";

// Share-URL codec: packs a drawing into a compact URL-safe base64 string that
// fits in the fragment of `/#d=<...>`. Layout:
//   byte 0:         version (1)
//   bytes 1..16:    active palette (16 base-palette indices)
//   byte 17:        frame count
//   bytes 18...:    frames, packed at 5 bits per pixel (16 values + transparent)
//
// 5 bits per pixel × 256 pixels per frame = 1280 bits = 160 bytes per frame.
// Single-frame: 1 + 16 + 1 + 160 = 178 bytes → ~240 base64url chars.
// 16 frames:   1 + 16 + 1 + 2560 = 2578 bytes → ~3440 base64url chars.
const VERSION = 1;
const BITS_PER_PIXEL = 5;

export interface Drawing {
  frames: Bitmap[];
  activePalette: Uint8Array;
}

export function encodeShare(d: Drawing): string {
  if (d.activePalette.length !== ACTIVE_PALETTE_SIZE) {
    throw new Error("encodeShare: active palette wrong size");
  }
  if (d.frames.length === 0 || d.frames.length > MAX_FRAMES) {
    throw new Error(`encodeShare: bad frame count ${d.frames.length}`);
  }

  const frameBitLen = WIDTH * HEIGHT * BITS_PER_PIXEL;
  const frameByteLen = Math.ceil(frameBitLen / 8);
  const buf = new Uint8Array(1 + ACTIVE_PALETTE_SIZE + 1 + frameByteLen * d.frames.length);
  let p = 0;
  buf[p++] = VERSION;
  buf.set(d.activePalette, p); p += ACTIVE_PALETTE_SIZE;
  buf[p++] = d.frames.length;

  for (const frame of d.frames) {
    packFrame(frame, buf, p);
    p += frameByteLen;
  }
  return base64urlEncode(buf);
}

export function decodeShare(str: string): Drawing {
  const buf = base64urlDecode(str);
  let p = 0;
  const version = buf[p++];
  if (version !== VERSION) throw new Error(`decodeShare: unknown version ${version}`);
  const activePalette = buf.slice(p, p + ACTIVE_PALETTE_SIZE);
  p += ACTIVE_PALETTE_SIZE;
  const frameCount = buf[p++];
  if (frameCount === 0 || frameCount > MAX_FRAMES) {
    throw new Error(`decodeShare: bad frame count ${frameCount}`);
  }
  const frames: Bitmap[] = [];
  const frameBitLen = WIDTH * HEIGHT * BITS_PER_PIXEL;
  const frameByteLen = Math.ceil(frameBitLen / 8);
  for (let i = 0; i < frameCount; i++) {
    frames.push(unpackFrame(buf, p));
    p += frameByteLen;
  }
  return { frames, activePalette };
}

function packFrame(frame: Bitmap, out: Uint8Array, offset: number): void {
  let bitBuf = 0;
  let bitCount = 0;
  let pos = offset;
  for (let i = 0; i < frame.data.length; i++) {
    const v = frame.data[i]; // 0..16
    bitBuf |= v << bitCount;
    bitCount += BITS_PER_PIXEL;
    while (bitCount >= 8) {
      out[pos++] = bitBuf & 0xff;
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  }
  if (bitCount > 0) {
    out[pos] = bitBuf & 0xff;
  }
}

function unpackFrame(buf: Uint8Array, offset: number): Bitmap {
  const data = new Uint8Array(WIDTH * HEIGHT);
  let bitBuf = 0;
  let bitCount = 0;
  let pos = offset;
  for (let i = 0; i < data.length; i++) {
    while (bitCount < BITS_PER_PIXEL) {
      bitBuf |= buf[pos++] << bitCount;
      bitCount += 8;
    }
    const v = bitBuf & ((1 << BITS_PER_PIXEL) - 1);
    bitBuf >>>= BITS_PER_PIXEL;
    bitCount -= BITS_PER_PIXEL;
    data[i] = v > TRANSPARENT ? TRANSPARENT : v;
  }
  return new Bitmap(WIDTH, HEIGHT, data);
}

export function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
