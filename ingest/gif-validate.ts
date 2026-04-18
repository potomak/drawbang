import {
  ACTIVE_PALETTE_SIZE,
  DRAWBANG_APP_IDENTIFIER,
  HEIGHT,
  MAX_FRAMES,
  MAX_GIF_BYTES,
  WIDTH,
} from "../config/constants.js";

const textDecoder = new TextDecoder("ascii");

export interface GifValidation {
  frameCount: number;
  activePalette: Uint8Array;
}

// Validates a GIF against the editor's hard limits. Throws a descriptive
// Error if anything is off; returns the frame count and DRAWBANG active
// palette on success. Does not perform LZW decoding — it only scans block
// boundaries and reads the application extension we embed.
export function validateGif(bytes: Uint8Array): GifValidation {
  if (bytes.length > MAX_GIF_BYTES) {
    throw new Error(`gif too large: ${bytes.length} > ${MAX_GIF_BYTES}`);
  }
  if (bytes.length < 13) throw new Error("gif too short");
  if (textDecoder.decode(bytes.subarray(0, 6)) !== "GIF89a") {
    throw new Error("not a GIF89a");
  }
  const lsdW = bytes[6] | (bytes[7] << 8);
  const lsdH = bytes[8] | (bytes[9] << 8);
  if (lsdW !== WIDTH || lsdH !== HEIGHT) {
    throw new Error(`gif size ${lsdW}x${lsdH} != ${WIDTH}x${HEIGHT}`);
  }
  const packed = bytes[10];
  let p = 13;
  if ((packed & 0x80) === 0) throw new Error("gif missing global color table");
  const gctSize = 1 << ((packed & 0x07) + 1);
  if (gctSize > 32) throw new Error(`gct too large: ${gctSize}`);
  p += gctSize * 3;

  let frameCount = 0;
  let activePalette: Uint8Array | null = null;

  while (p < bytes.length) {
    const marker = bytes[p];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      p++;
      const label = bytes[p++];
      if (label === 0xff) {
        const blockSize = bytes[p++];
        if (blockSize !== 0x0b) {
          p = skipSubBlocks(bytes, p);
          continue;
        }
        const ident = textDecoder.decode(bytes.subarray(p, p + 8));
        p += 8;
        p += 3; // auth
        if (ident === DRAWBANG_APP_IDENTIFIER) {
          const subSize = bytes[p++];
          if (subSize !== ACTIVE_PALETTE_SIZE) {
            throw new Error(`DRAWBANG sub-block wrong size: ${subSize}`);
          }
          activePalette = bytes.slice(p, p + ACTIVE_PALETTE_SIZE);
          p += ACTIVE_PALETTE_SIZE;
          if (bytes[p++] !== 0x00) throw new Error("DRAWBANG block missing terminator");
        } else {
          p = skipSubBlocks(bytes, p);
        }
      } else {
        // GCE (0xF9), comment (0xFE), plain text (0x01) — skip size + sub-blocks
        const size = bytes[p++];
        p += size;
        p = skipSubBlocks(bytes, p);
      }
    } else if (marker === 0x2c) {
      frameCount++;
      if (frameCount > MAX_FRAMES) throw new Error(`too many frames (> ${MAX_FRAMES})`);
      p++;
      const ix = bytes[p] | (bytes[p + 1] << 8);
      const iy = bytes[p + 2] | (bytes[p + 3] << 8);
      const iw = bytes[p + 4] | (bytes[p + 5] << 8);
      const ih = bytes[p + 6] | (bytes[p + 7] << 8);
      if (ix < 0 || iy < 0 || ix + iw > WIDTH || iy + ih > HEIGHT) {
        throw new Error(`frame image descriptor out of bounds`);
      }
      p += 8;
      const imgPacked = bytes[p++];
      if (imgPacked & 0x80) {
        const lctSize = 1 << ((imgPacked & 0x07) + 1);
        p += lctSize * 3;
      }
      p++; // LZW min code size
      p = skipSubBlocks(bytes, p);
    } else {
      throw new Error(`unexpected byte 0x${marker.toString(16)} at offset ${p}`);
    }
  }

  if (frameCount === 0) throw new Error("gif has no frames");
  if (!activePalette) throw new Error("gif missing DRAWBANG application extension");
  return { frameCount, activePalette };
}

function skipSubBlocks(bytes: Uint8Array, p: number): number {
  while (p < bytes.length) {
    const size = bytes[p++];
    if (size === 0) break;
    p += size;
  }
  return p;
}
