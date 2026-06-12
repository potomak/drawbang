import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { PixelPerfectStroke } from "../src/editor/tools.js";

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
