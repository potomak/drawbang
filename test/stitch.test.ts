import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { stitchCompositeGif, stitchCompositePng, ogScale } from "../ingest/stitch.js";
// @ts-expect-error omggif ships no TS types
import { GifReader } from "omggif";

function frameCount(gif: Uint8Array): number {
  return new GifReader(Buffer.from(gif)).numFrames();
}

// A single-frame 16×16 tile painted with one palette slot.
function tile(slot: number): Uint8Array {
  const frame = new Bitmap();
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) frame.set(x, y, slot);
  return encodeGif({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });
}

// A two-frame tile: frame 0 = slotA, frame 1 = slotB.
function animTile(slotA: number, slotB: number): Uint8Array {
  const f0 = new Bitmap();
  const f1 = new Bitmap();
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      f0.set(x, y, slotA);
      f1.set(x, y, slotB);
    }
  return encodeGif({ frames: [f0, f1], activePalette: DEFAULT_ACTIVE_PALETTE });
}

function gifSize(bytes: Uint8Array): { w: number; h: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
}

describe("stitchCompositeGif", () => {
  test("a 2×1 composite has the merged dimensions and is a GIF", async () => {
    const out = await stitchCompositeGif(
      [
        { x: 0, y: 0, gif: tile(1) },
        { x: 1, y: 0, gif: tile(2) },
      ],
      2,
      1,
    );
    assert.ok(out, "composite produced");
    assert.equal(out[0], 0x47); // 'G'
    assert.deepEqual(gifSize(out), { w: 32, h: 16 });
  });

  test("animation is preserved: a 2-frame tile yields a 2-frame composite", async () => {
    const out = await stitchCompositeGif([{ x: 0, y: 0, gif: animTile(1, 2) }], 1, 1);
    assert.ok(out);
    assert.equal(frameCount(out), 2);
  });

  test("frameCount is the max across tiles; shorter tiles loop", async () => {
    const out = await stitchCompositeGif(
      [
        { x: 0, y: 0, gif: animTile(1, 2) }, // 2 frames
        { x: 1, y: 0, gif: tile(3) }, // 1 frame
      ],
      2,
      1,
    );
    assert.ok(out);
    assert.equal(frameCount(out), 2);
  });
});

describe("stitch helpers", () => {
  test("stitchCompositePng renders the merged raster at the requested scale", async () => {
    const png = await stitchCompositePng(
      [
        { x: 0, y: 0, gif: tile(1) },
        { x: 0, y: 1, gif: tile(2) },
      ],
      1,
      2,
      4,
    );
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    assert.equal(png[0], 0x89); // PNG magic
    assert.equal(dv.getUint32(16), 16 * 4); // width = 1*16*scale
    assert.equal(dv.getUint32(20), 32 * 4); // height = 2*16*scale
  });

  test("ogScale brings the longest side to ~960px", () => {
    assert.equal(ogScale(1, 1), 60); // 16 → floor(960/16)
    assert.equal(ogScale(4, 4), 15); // 64 → floor(960/64)
    assert.ok(ogScale(4, 1) >= 1);
  });
});
