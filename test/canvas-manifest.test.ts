import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  CANVAS_MAX_COLS,
  CANVAS_MAX_ROWS,
  canonicalCanvasString,
  canvasIdFor,
  isManifestValid,
  type CanvasManifest,
} from "../config/canvas.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("canvas manifest", () => {
  test("canonical string encodes shape + row-major cells with explicit nulls", () => {
    const m: CanvasManifest = { cols: 2, rows: 1, tiles: [A, null] };
    assert.equal(
      canonicalCanvasString(m),
      `drawbang-canvas/v1\n2x1\n${A}\n-`,
    );
  });

  test("canvas id is deterministic for the same manifest", async () => {
    const m: CanvasManifest = { cols: 2, rows: 2, tiles: [A, B, null, A] };
    assert.equal(await canvasIdFor(m), await canvasIdFor({ ...m, tiles: [...m.tiles] }));
    assert.match(await canvasIdFor(m), /^[0-9a-f]{64}$/);
  });

  test("tile order and null placement change the id", async () => {
    const base = await canvasIdFor({ cols: 2, rows: 1, tiles: [A, B] });
    assert.notEqual(base, await canvasIdFor({ cols: 2, rows: 1, tiles: [B, A] }));
    assert.notEqual(base, await canvasIdFor({ cols: 2, rows: 1, tiles: [A, null] }));
  });

  test("shape changes the id even with same filled tiles", async () => {
    const a = await canvasIdFor({ cols: 2, rows: 1, tiles: [A, B] });
    const b = await canvasIdFor({ cols: 1, rows: 2, tiles: [A, B] });
    assert.notEqual(a, b);
  });

  test("isManifestValid accepts a well-formed manifest", () => {
    assert.equal(isManifestValid({ cols: 2, rows: 2, tiles: [A, null, null, B] }), true);
    assert.equal(isManifestValid({ cols: 1, rows: 1, tiles: [A] }), true);
  });

  test("isManifestValid rejects bad shape, length, ids, or all-empty", () => {
    assert.equal(isManifestValid({ cols: 0, rows: 1, tiles: [] }), false);
    assert.equal(isManifestValid({ cols: CANVAS_MAX_COLS + 1, rows: 1, tiles: [A] }), false);
    assert.equal(isManifestValid({ cols: 2, rows: 2, tiles: [A] }), false); // wrong length
    assert.equal(isManifestValid({ cols: 1, rows: 1, tiles: ["nothex"] }), false);
    assert.equal(isManifestValid({ cols: 2, rows: 1, tiles: [null, null] }), false); // all empty
  });

  test("respects the configured caps", () => {
    const tiles = Array(CANVAS_MAX_COLS * CANVAS_MAX_ROWS).fill(A);
    assert.equal(isManifestValid({ cols: CANVAS_MAX_COLS, rows: CANVAS_MAX_ROWS, tiles }), true);
  });
});
