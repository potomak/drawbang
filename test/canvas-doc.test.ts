import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { Bitmap, TRANSPARENT } from "../src/editor/bitmap.js";
import {
  createCanvasDoc,
  filledCells,
  framesEmpty,
  getCell,
  growCols,
  growRows,
  isMultiTile,
  setCell,
} from "../src/editor/canvas-doc.js";
import { CANVAS_MAX_COLS, CANVAS_MAX_ROWS } from "../config/canvas.js";

function filledFrame(): Bitmap {
  const b = new Bitmap();
  b.set(0, 0, 3);
  return b;
}

describe("canvas-doc", () => {
  test("defaults to a single empty cell", () => {
    const d = createCanvasDoc();
    assert.equal(d.cols, 1);
    assert.equal(d.rows, 1);
    assert.equal(isMultiTile(d), false);
    assert.equal(filledCells(d).length, 0);
  });

  test("framesEmpty detects all-transparent vs drawn", () => {
    assert.equal(framesEmpty([new Bitmap()]), true);
    assert.equal(framesEmpty([filledFrame()]), false);
    const partial = new Bitmap();
    assert.equal(partial.data.every((p) => p === TRANSPARENT), true);
  });

  test("setCell / getCell round-trip", () => {
    const d = createCanvasDoc();
    const frames = [filledFrame()];
    setCell(d, 0, 0, frames);
    assert.equal(getCell(d, 0, 0), frames);
    assert.equal(getCell(d, 1, 0), undefined);
  });

  test("grow caps at the configured max and grows otherwise", () => {
    const d = createCanvasDoc();
    assert.equal(growCols(d), true);
    assert.equal(growRows(d), true);
    assert.equal(d.cols, 2);
    assert.equal(d.rows, 2);
    while (growCols(d)) {}
    while (growRows(d)) {}
    assert.equal(d.cols, CANVAS_MAX_COLS);
    assert.equal(d.rows, CANVAS_MAX_ROWS);
    assert.equal(growCols(d), false);
    assert.equal(growRows(d), false);
  });

  test("filledCells returns non-empty cells in row-major order, skipping empties", () => {
    const d = createCanvasDoc();
    growCols(d); // 2x1
    setCell(d, 1, 0, [filledFrame()]);
    setCell(d, 0, 0, [new Bitmap()]); // empty → skipped
    const filled = filledCells(d);
    assert.equal(filled.length, 1);
    assert.equal(filled[0].x, 1);
    assert.equal(filled[0].y, 0);
  });

  test("isMultiTile reflects grid size", () => {
    const d = createCanvasDoc();
    assert.equal(isMultiTile(d), false);
    growCols(d);
    assert.equal(isMultiTile(d), true);
  });
});
