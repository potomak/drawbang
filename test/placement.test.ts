import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_PLACEMENT,
  NAMED_PRESETS,
  PATTERN_PRESETS,
  PLACEMENT_PRESETS,
  expandPlacement,
  isValidPlacement,
  patternGridSize,
} from "../merch/placement.js";

test("DEFAULT_PLACEMENT is full-chest — preserves the pre-#147 behaviour for old orders", () => {
  assert.equal(DEFAULT_PLACEMENT, "full-chest");
});

test("isValidPlacement: every entry in PLACEMENT_PRESETS validates; unknown strings + non-strings do not", () => {
  for (const p of PLACEMENT_PRESETS) {
    assert.equal(isValidPlacement(p), true, p);
  }
  assert.equal(isValidPlacement(""), false);
  assert.equal(isValidPlacement("pattern-1x1"), false); // < 2 not exposed
  assert.equal(isValidPlacement("pattern-9x9"), false); // > 8 not exposed
  assert.equal(isValidPlacement("pattern-2x3"), false); // not square
  assert.equal(isValidPlacement(null), false);
  assert.equal(isValidPlacement(42), false);
});

test("expandPlacement: full-chest centres at (0.5, 0.5) scale 1 — matches the pre-feature constant", () => {
  const out = expandPlacement("full-chest", "img-1");
  assert.deepEqual(out, [{ id: "img-1", x: 0.5, y: 0.5, scale: 1, angle: 0 }]);
});

test("expandPlacement: small named presets land in the right corners at scale 0.25", () => {
  assert.deepEqual(expandPlacement("left-chest", "img-1"), [
    { id: "img-1", x: 0.3, y: 0.25, scale: 0.25, angle: 0 },
  ]);
  assert.deepEqual(expandPlacement("right-chest", "img-1"), [
    { id: "img-1", x: 0.7, y: 0.25, scale: 0.25, angle: 0 },
  ]);
  assert.deepEqual(expandPlacement("center-pocket", "img-1"), [
    { id: "img-1", x: 0.5, y: 0.3, scale: 0.25, angle: 0 },
  ]);
});

test("expandPlacement: pattern-2x2 returns 4 entries on a half-cell grid, scale 1/2", () => {
  const out = expandPlacement("pattern-2x2", "img-1");
  assert.equal(out.length, 4);
  for (const e of out) {
    assert.equal(e.id, "img-1");
    assert.equal(e.scale, 0.5);
    assert.equal(e.angle, 0);
  }
  assert.deepEqual(out.map((e) => [e.x, e.y]), [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ]);
});

test("expandPlacement: pattern-8x8 returns 64 entries — every cell-centre in row-major order, scale 1/8", () => {
  const out = expandPlacement("pattern-8x8", "img-1");
  assert.equal(out.length, 64);
  // Spot-check first, last, and the cell at row 3 col 5.
  assert.deepEqual(out[0], { id: "img-1", x: 0.0625, y: 0.0625, scale: 0.125, angle: 0 });
  assert.deepEqual(out[63], { id: "img-1", x: 0.9375, y: 0.9375, scale: 0.125, angle: 0 });
  assert.deepEqual(out[3 * 8 + 5], { id: "img-1", x: 0.6875, y: 0.4375, scale: 0.125, angle: 0 });
});

test("expandPlacement: every pattern-NxN entry has scale ~ 1/N", () => {
  for (const preset of PATTERN_PRESETS) {
    const n = patternGridSize(preset)!;
    const out = expandPlacement(preset, "x");
    assert.equal(out.length, n * n, preset);
    for (const e of out) {
      assert.ok(Math.abs(e.scale - 1 / n) < 1e-9, `${preset} scale = ${e.scale}`);
    }
  }
});

test("expandPlacement: pattern cell positions never leave the [0, 1] range", () => {
  // Visual sanity — a cell-centre at (col+0.5)/n is always strictly inside
  // (0, 1) for n ≥ 1 and col in 0..n-1, but the asserts double-lock the
  // formula in case someone "simplifies" patternGrid later.
  for (const preset of PATTERN_PRESETS) {
    for (const e of expandPlacement(preset, "x")) {
      assert.ok(e.x > 0 && e.x < 1, `${preset} x = ${e.x}`);
      assert.ok(e.y > 0 && e.y < 1, `${preset} y = ${e.y}`);
    }
  }
});

test("expandPlacement: rejects bogus placement strings at runtime even though the type is narrowed", () => {
  // Defence in depth — bad data in the DynamoDB row should throw, not
  // produce a malformed payload that 422s further upstream.
  assert.throws(() => expandPlacement("pattern-99x99" as never, "x"));
  assert.throws(() => expandPlacement("garbage" as never, "x"));
});

test("NAMED_PRESETS + PATTERN_PRESETS partition PLACEMENT_PRESETS with no overlap", () => {
  const named = new Set<string>(NAMED_PRESETS);
  const pattern = new Set<string>(PATTERN_PRESETS);
  for (const n of named) assert.equal(pattern.has(n), false, `overlap: ${n}`);
  assert.equal(named.size + pattern.size, PLACEMENT_PRESETS.length);
});

test("patternGridSize: returns N for pattern presets, null for named presets", () => {
  assert.equal(patternGridSize("pattern-2x2"), 2);
  assert.equal(patternGridSize("pattern-8x8"), 8);
  assert.equal(patternGridSize("full-chest"), null);
  assert.equal(patternGridSize("left-chest"), null);
});
