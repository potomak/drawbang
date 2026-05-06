import { strict as assert } from "node:assert";
import { test } from "node:test";
// @ts-expect-error omggif ships no TS types
import { GifReader } from "omggif";
import { Bitmap, TRANSPARENT } from "../src/editor/bitmap.js";
import { encodeScaledGif } from "../src/editor/scaled-gif.js";
import {
  DEFAULT_ACTIVE_PALETTE,
  activePaletteToRgb,
} from "../src/editor/palette.js";

test("emits a single-frame GIF with the requested integer-scaled dimensions", () => {
  const b = new Bitmap();
  for (let x = 0; x < 16; x++) b.set(x, 8, 3);
  const bytes = encodeScaledGif({
    frames: [b],
    activePalette: DEFAULT_ACTIVE_PALETTE,
    scale: 20,
  });
  const reader = new GifReader(bytes) as { width: number; height: number; numFrames(): number };
  assert.equal(reader.width, 320);
  assert.equal(reader.height, 320);
  assert.equal(reader.numFrames(), 1);
});

test("preserves multi-frame count + delay", () => {
  const frames = Array.from({ length: 4 }, (_, i) => {
    const b = new Bitmap();
    b.set(0, 0, (i % 15) + 1);
    return b;
  });
  const bytes = encodeScaledGif({
    frames,
    activePalette: DEFAULT_ACTIVE_PALETTE,
    scale: 8,
    delayMs: 200,
  });
  const reader = new GifReader(bytes) as {
    width: number;
    height: number;
    numFrames(): number;
    frameInfo(i: number): { delay: number };
  };
  assert.equal(reader.width, 128);
  assert.equal(reader.height, 128);
  assert.equal(reader.numFrames(), 4);
  // omggif reports the GIF delay in centiseconds; encoder writes 20.
  assert.equal(reader.frameInfo(0).delay, 20);
});

test("each source pixel becomes a scale×scale block of the same color", () => {
  // Single colored pixel at (3, 5) with a known active-palette slot.
  const slot = 7;
  const frame = new Bitmap();
  frame.set(3, 5, slot);

  const scale = 4;
  const bytes = encodeScaledGif({
    frames: [frame],
    activePalette: DEFAULT_ACTIVE_PALETTE,
    scale,
  });

  const reader = new GifReader(bytes) as {
    width: number;
    height: number;
    decodeAndBlitFrameRGBA(i: number, out: Uint8Array): void;
  };
  const rgba = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, rgba);

  const [er, eg, eb] = activePaletteToRgb(DEFAULT_ACTIVE_PALETTE)[slot];

  // All scale*scale pixels in the upscaled block should match the source slot.
  for (let dy = 0; dy < scale; dy++) {
    for (let dx = 0; dx < scale; dx++) {
      const px = (3 * scale + dx) + (5 * scale + dy) * reader.width;
      const i = px * 4;
      assert.equal(rgba[i], er);
      assert.equal(rgba[i + 1], eg);
      assert.equal(rgba[i + 2], eb);
      assert.equal(rgba[i + 3], 255);
    }
  }

  // A different cell that we left transparent should be alpha=0.
  const px = (10 * scale) + (10 * scale) * reader.width;
  assert.equal(rgba[px * 4 + 3], 0, "untouched cells stay transparent");
});

test("rejects non-positive or non-integer scale", () => {
  const b = new Bitmap();
  assert.throws(
    () => encodeScaledGif({ frames: [b], activePalette: DEFAULT_ACTIVE_PALETTE, scale: 0 }),
    /scale/,
  );
  assert.throws(
    () => encodeScaledGif({ frames: [b], activePalette: DEFAULT_ACTIVE_PALETTE, scale: 1.5 }),
    /scale/,
  );
});

test("transparent source pixels remain transparent in the upscale", () => {
  const frame = new Bitmap();
  frame.set(0, 0, 1);
  frame.set(15, 15, TRANSPARENT);
  const bytes = encodeScaledGif({
    frames: [frame],
    activePalette: DEFAULT_ACTIVE_PALETTE,
    scale: 2,
  });
  const reader = new GifReader(bytes) as {
    width: number;
    height: number;
    decodeAndBlitFrameRGBA(i: number, out: Uint8Array): void;
  };
  const rgba = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, rgba);
  // Bottom-right 2x2 block should all be alpha 0.
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const px = (30 + dx) + (30 + dy) * reader.width;
      assert.equal(rgba[px * 4 + 3], 0);
    }
  }
});
