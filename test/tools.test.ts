import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  PixelPerfectStroke,
  shiftRight,
  shiftUp,
  translate,
} from "../src/editor/tools.js";
import { Bitmap } from "../src/editor/bitmap.js";

describe("PixelPerfectStroke", () => {
  test("straight strokes never flag a corner", () => {
    const s = new PixelPerfectStroke();
    assert.equal(s.next(0, 0), null);
    assert.equal(s.next(1, 0), null);
    assert.equal(s.next(2, 0), null);
    assert.equal(s.next(3, 0), null);
  });

  test("an L turn flags the corner cell", () => {
    const s = new PixelPerfectStroke();
    s.next(0, 0);
    s.next(1, 0);
    assert.deepEqual(s.next(1, 1), { x: 1, y: 0 });
  });

  test("a staircase collapses corner by corner into a clean diagonal", () => {
    const s = new PixelPerfectStroke();
    const removed: Array<{ x: number; y: number } | null> = [
      s.next(0, 0),
      s.next(1, 0),
      s.next(1, 1),
      s.next(2, 1),
      s.next(2, 2),
    ];
    assert.deepEqual(removed, [null, null, { x: 1, y: 0 }, null, { x: 2, y: 1 }]);
  });

  test("repeated pointer events on the same cell are ignored", () => {
    const s = new PixelPerfectStroke();
    s.next(0, 0);
    assert.equal(s.next(0, 0), null);
    s.next(1, 0);
    assert.equal(s.next(1, 0), null);
    // The duplicate must not have broken corner detection.
    assert.deepEqual(s.next(1, 1), { x: 1, y: 0 });
  });

  test("a U turn back onto the previous cell is not a corner", () => {
    const s = new PixelPerfectStroke();
    s.next(0, 0);
    s.next(1, 0);
    assert.equal(s.next(0, 0), null);
  });

  test("fast-pointer jumps (non-adjacent cells) are not corners", () => {
    const s = new PixelPerfectStroke();
    s.next(0, 0);
    s.next(2, 0);
    assert.equal(s.next(2, 1), null);
  });

  test("diagonal pointer movement is not a corner", () => {
    const s = new PixelPerfectStroke();
    s.next(0, 0);
    s.next(1, 1);
    assert.equal(s.next(1, 2), null);
  });

  test("fewer than three visited cells never flags", () => {
    const s = new PixelPerfectStroke();
    assert.equal(s.next(5, 5), null);
    assert.equal(s.next(5, 6), null);
  });
});

describe("translate", () => {
  // 4×4 canvas with a unique value per cell so wrap math is verifiable
  // by inspecting the resulting flat array.
  function makeBitmap(): Bitmap {
    // 16 is TRANSPARENT, so keep values in [0, 15] to satisfy Bitmap.set's
    // PIXEL_STATES guard.
    const data = new Uint8Array(16);
    for (let i = 0; i < 16; i++) data[i] = i % 16;
    return Bitmap.fromArray(data, 4, 4);
  }

  test("(0, 0) is a no-op", () => {
    const src = makeBitmap();
    const dst = new Bitmap(4, 4);
    translate(dst, src, 0, 0);
    assert.deepEqual(Array.from(dst.data), Array.from(src.data));
  });

  test("(1, 0) matches shiftRight", () => {
    const src = makeBitmap();
    const a = new Bitmap(4, 4);
    translate(a, src, 1, 0);
    const b = src.clone();
    shiftRight(b);
    assert.deepEqual(Array.from(a.data), Array.from(b.data));
  });

  test("(0, -1) matches shiftUp", () => {
    const src = makeBitmap();
    const a = new Bitmap(4, 4);
    translate(a, src, 0, -1);
    const b = src.clone();
    shiftUp(b);
    assert.deepEqual(Array.from(a.data), Array.from(b.data));
  });

  test("(-1, 0) wraps the left column to the right edge", () => {
    const src = makeBitmap();
    const dst = new Bitmap(4, 4);
    translate(dst, src, -1, 0);
    // Column 0 of dst = column 1 of src; column 3 of dst = column 0 of src.
    for (let y = 0; y < 4; y++) {
      assert.equal(dst.get(0, y), src.get(1, y));
      assert.equal(dst.get(3, y), src.get(0, y));
    }
  });

  test("(w, 0) is identity (full wrap)", () => {
    const src = makeBitmap();
    const dst = new Bitmap(4, 4);
    translate(dst, src, 4, 0);
    assert.deepEqual(Array.from(dst.data), Array.from(src.data));
  });

  test("large positive + negative deltas normalize via modulo", () => {
    const src = makeBitmap();
    const a = new Bitmap(4, 4);
    const b = new Bitmap(4, 4);
    translate(a, src, 9, -7);
    translate(b, src, 9 % 4, ((-7 % 4) + 4) % 4);
    assert.deepEqual(Array.from(a.data), Array.from(b.data));
  });
});
