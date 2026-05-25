import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { Bitmap, TRANSPARENT } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { buildCanvasComposite } from "../src/canvas-composite.js";

// A 16×16 tile filled with one palette slot, optional second frame.
function tile(slotA: number, slotB?: number): Uint8Array {
  const f0 = new Bitmap();
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) f0.set(x, y, slotA);
  const frames = [f0];
  if (slotB !== undefined) {
    const f1 = new Bitmap();
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) f1.set(x, y, slotB);
    frames.push(f1);
  }
  return encodeGif({ frames, activePalette: DEFAULT_ACTIVE_PALETTE });
}

describe("buildCanvasComposite", () => {
  test("a 2×1 canvas letterboxes into a square 2×2 (32×32) composite", () => {
    const c = buildCanvasComposite(
      [
        { x: 0, y: 0, gif: tile(1) },
        { x: 1, y: 0, gif: tile(2) },
      ],
      2,
      1,
    );
    assert.equal(c.side, 2);
    assert.equal(c.frames.length, 1);
    const f = c.frames[0];
    assert.equal(f.width, 32);
    assert.equal(f.height, 32);
    // Tiles sit in the top row; the padded second row is transparent.
    assert.equal(f.get(0, 0), 1);
    assert.equal(f.get(16, 0), 2);
    assert.equal(f.get(0, 16), TRANSPARENT);
    assert.equal(f.get(16, 16), TRANSPARENT);
  });

  test("a 1×1 canvas is a 16×16 composite (parity with a single tile)", () => {
    const c = buildCanvasComposite([{ x: 0, y: 0, gif: tile(5) }], 1, 1);
    assert.equal(c.side, 1);
    assert.equal(c.frames[0].width, 16);
    assert.equal(c.frames[0].get(0, 0), 5);
  });

  test("a non-square canvas is centered (3×1 → middle row of a 3×3)", () => {
    const c = buildCanvasComposite([{ x: 0, y: 0, gif: tile(7) }], 3, 1);
    assert.equal(c.side, 3);
    assert.equal(c.frames[0].width, 48);
    // offRows = floor((3-1)/2) = 1 → the tile lands in the middle row.
    assert.equal(c.frames[0].get(0, 0), TRANSPARENT);
    assert.equal(c.frames[0].get(0, 16), 7);
    assert.equal(c.frames[0].get(0, 32), TRANSPARENT);
  });

  test("animation is preserved: a 2-frame tile yields 2 composite frames", () => {
    const c = buildCanvasComposite([{ x: 0, y: 0, gif: tile(1, 2) }], 1, 1);
    assert.equal(c.frames.length, 2);
    assert.equal(c.frames[0].get(0, 0), 1);
    assert.equal(c.frames[1].get(0, 0), 2);
  });

  test("frame count is the max across tiles; shorter tiles loop", () => {
    const c = buildCanvasComposite(
      [
        { x: 0, y: 0, gif: tile(1, 2) }, // 2 frames
        { x: 1, y: 0, gif: tile(3) }, // 1 frame, loops
      ],
      2,
      1,
    );
    assert.equal(c.frames.length, 2);
    assert.equal(c.frames[0].get(16, 0), 3);
    assert.equal(c.frames[1].get(16, 0), 3); // looped
  });

  test("activePalette comes from the first decoded tile", () => {
    const c = buildCanvasComposite([{ x: 0, y: 0, gif: tile(1) }], 1, 1);
    assert.deepEqual(Array.from(c.activePalette), Array.from(DEFAULT_ACTIVE_PALETTE));
  });
});
