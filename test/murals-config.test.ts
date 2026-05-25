import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import {
  muralIdForDate,
  muralOpensAt,
  muralClosesAt,
  muralName,
  tileKey,
  parseTileKey,
  isTileKeyValid,
  isMuralIdValid,
  TILES_PER_SIDE,
  TILES_PER_MURAL,
  CLAIM_TTL_S,
  PUBLISH_COOLDOWN_S,
} from "../config/murals.js";

describe("murals config", () => {
  test("constants", () => {
    assert.equal(TILES_PER_SIDE, 16);
    assert.equal(TILES_PER_MURAL, 256);
    assert.equal(CLAIM_TTL_S, 1800);
    assert.equal(PUBLISH_COOLDOWN_S, 900);
  });

  describe("muralIdForDate", () => {
    test("2026-05-16 (Saturday) → mural-2026-W20", () => {
      assert.equal(
        muralIdForDate(new Date("2026-05-16T12:00:00Z")),
        "mural-2026-W20",
      );
    });

    test("2026-01-01 (Thursday) → mural-2026-W01", () => {
      assert.equal(
        muralIdForDate(new Date("2026-01-01T00:00:00Z")),
        "mural-2026-W01",
      );
    });

    test("2027-01-03 (Sunday) belongs to mural-2026-W53", () => {
      assert.equal(
        muralIdForDate(new Date("2027-01-03T23:59:59Z")),
        "mural-2026-W53",
      );
    });

    test("2027-01-04 (Monday) → mural-2027-W01", () => {
      assert.equal(
        muralIdForDate(new Date("2027-01-04T00:00:00Z")),
        "mural-2027-W01",
      );
    });

    test("ISO year start: 2025-12-29 (Monday) → mural-2026-W01", () => {
      assert.equal(
        muralIdForDate(new Date("2025-12-29T00:00:00Z")),
        "mural-2026-W01",
      );
    });
  });

  describe("muralOpensAt / muralClosesAt", () => {
    test("mural-2026-W20 opens 2026-05-11 00:00 UTC", () => {
      assert.equal(
        muralOpensAt("mural-2026-W20").toISOString(),
        "2026-05-11T00:00:00.000Z",
      );
    });

    test("mural-2026-W01 opens 2025-12-29 (Monday before Jan 1 Thursday)", () => {
      assert.equal(
        muralOpensAt("mural-2026-W01").toISOString(),
        "2025-12-29T00:00:00.000Z",
      );
    });

    test("opens → closes is always exactly 7 days", () => {
      const ids = [
        "mural-2026-W01",
        "mural-2026-W20",
        "mural-2026-W53",
        "mural-2027-W01",
      ];
      for (const id of ids) {
        const opens = muralOpensAt(id).getTime();
        const closes = muralClosesAt(id).getTime();
        assert.equal(closes - opens, 7 * 86_400_000, `${id} should span 7 days`);
      }
    });

    test("round-trip: muralIdForDate(opens) === id", () => {
      for (const id of ["mural-2026-W01", "mural-2026-W20", "mural-2027-W01"]) {
        assert.equal(muralIdForDate(muralOpensAt(id)), id);
      }
    });

    test("throws on invalid id", () => {
      assert.throws(() => muralOpensAt("invalid"));
      assert.throws(() => muralOpensAt("mural-2026-W1"));
    });
  });

  describe("muralName", () => {
    test("formats as 'Week W, YYYY'", () => {
      assert.equal(muralName("mural-2026-W20"), "Week 20, 2026");
      assert.equal(muralName("mural-2026-W01"), "Week 1, 2026");
    });

    test("returns id unchanged when malformed", () => {
      assert.equal(muralName("bogus"), "bogus");
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

  describe("isMuralIdValid", () => {
    test("accepts well-formed ids", () => {
      assert.equal(isMuralIdValid("mural-2026-W20"), true);
      assert.equal(isMuralIdValid("mural-2026-W01"), true);
      assert.equal(isMuralIdValid("mural-2026-W53"), true);
    });

    test("rejects malformed", () => {
      assert.equal(isMuralIdValid("mural-2026-W1"), false);
      assert.equal(isMuralIdValid("mural-26-W20"), false);
      assert.equal(isMuralIdValid("foo"), false);
      assert.equal(isMuralIdValid(""), false);
    });
  });
});
