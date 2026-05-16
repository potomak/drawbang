import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import {
  canvasIdForDate,
  canvasOpensAt,
  canvasClosesAt,
  canvasName,
  tileKey,
  parseTileKey,
  isTileKeyValid,
  isCanvasIdValid,
  TILES_PER_SIDE,
  TILES_PER_CANVAS,
  CLAIM_TTL_S,
  PUBLISH_COOLDOWN_S,
} from "../config/canvases.js";

describe("canvases config", () => {
  test("constants", () => {
    assert.equal(TILES_PER_SIDE, 16);
    assert.equal(TILES_PER_CANVAS, 256);
    assert.equal(CLAIM_TTL_S, 1800);
    assert.equal(PUBLISH_COOLDOWN_S, 900);
  });

  describe("canvasIdForDate", () => {
    test("2026-05-16 (Saturday) → canvas-2026-W20", () => {
      assert.equal(
        canvasIdForDate(new Date("2026-05-16T12:00:00Z")),
        "canvas-2026-W20",
      );
    });

    test("2026-01-01 (Thursday) → canvas-2026-W01", () => {
      assert.equal(
        canvasIdForDate(new Date("2026-01-01T00:00:00Z")),
        "canvas-2026-W01",
      );
    });

    test("2027-01-03 (Sunday) belongs to canvas-2026-W53", () => {
      assert.equal(
        canvasIdForDate(new Date("2027-01-03T23:59:59Z")),
        "canvas-2026-W53",
      );
    });

    test("2027-01-04 (Monday) → canvas-2027-W01", () => {
      assert.equal(
        canvasIdForDate(new Date("2027-01-04T00:00:00Z")),
        "canvas-2027-W01",
      );
    });

    test("ISO year start: 2025-12-29 (Monday) → canvas-2026-W01", () => {
      assert.equal(
        canvasIdForDate(new Date("2025-12-29T00:00:00Z")),
        "canvas-2026-W01",
      );
    });
  });

  describe("canvasOpensAt / canvasClosesAt", () => {
    test("canvas-2026-W20 opens 2026-05-11 00:00 UTC", () => {
      assert.equal(
        canvasOpensAt("canvas-2026-W20").toISOString(),
        "2026-05-11T00:00:00.000Z",
      );
    });

    test("canvas-2026-W01 opens 2025-12-29 (Monday before Jan 1 Thursday)", () => {
      assert.equal(
        canvasOpensAt("canvas-2026-W01").toISOString(),
        "2025-12-29T00:00:00.000Z",
      );
    });

    test("opens → closes is always exactly 7 days", () => {
      const ids = [
        "canvas-2026-W01",
        "canvas-2026-W20",
        "canvas-2026-W53",
        "canvas-2027-W01",
      ];
      for (const id of ids) {
        const opens = canvasOpensAt(id).getTime();
        const closes = canvasClosesAt(id).getTime();
        assert.equal(closes - opens, 7 * 86_400_000, `${id} should span 7 days`);
      }
    });

    test("round-trip: canvasIdForDate(opens) === id", () => {
      for (const id of ["canvas-2026-W01", "canvas-2026-W20", "canvas-2027-W01"]) {
        assert.equal(canvasIdForDate(canvasOpensAt(id)), id);
      }
    });

    test("throws on invalid id", () => {
      assert.throws(() => canvasOpensAt("invalid"));
      assert.throws(() => canvasOpensAt("canvas-2026-W1"));
    });
  });

  describe("canvasName", () => {
    test("formats as 'Week W, YYYY'", () => {
      assert.equal(canvasName("canvas-2026-W20"), "Week 20, 2026");
      assert.equal(canvasName("canvas-2026-W01"), "Week 1, 2026");
    });

    test("returns id unchanged when malformed", () => {
      assert.equal(canvasName("bogus"), "bogus");
    });
  });

  describe("tileKey / parseTileKey", () => {
    test("round-trips for valid coords", () => {
      for (const [x, y] of [[0, 0], [15, 15], [7, 11], [0, 15], [15, 0]]) {
        const k = tileKey(x, y);
        assert.deepEqual(parseTileKey(k), { x, y });
      }
    });

    test("rejects out-of-range and malformed", () => {
      assert.equal(parseTileKey("16,0"), null);
      assert.equal(parseTileKey("0,16"), null);
      assert.equal(parseTileKey("-1,5"), null);
      assert.equal(parseTileKey("a,b"), null);
      assert.equal(parseTileKey(""), null);
      assert.equal(parseTileKey("1,2,3"), null);
    });

    test("isTileKeyValid mirrors parseTileKey", () => {
      assert.equal(isTileKeyValid("0,0"), true);
      assert.equal(isTileKeyValid("15,15"), true);
      assert.equal(isTileKeyValid("16,0"), false);
      assert.equal(isTileKeyValid("-1,5"), false);
    });
  });

  describe("isCanvasIdValid", () => {
    test("accepts well-formed ids", () => {
      assert.equal(isCanvasIdValid("canvas-2026-W20"), true);
      assert.equal(isCanvasIdValid("canvas-2026-W01"), true);
      assert.equal(isCanvasIdValid("canvas-2026-W53"), true);
    });

    test("rejects malformed", () => {
      assert.equal(isCanvasIdValid("canvas-2026-W1"), false);
      assert.equal(isCanvasIdValid("canvas-26-W20"), false);
      assert.equal(isCanvasIdValid("foo"), false);
      assert.equal(isCanvasIdValid(""), false);
    });
  });
});
