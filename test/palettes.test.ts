import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ACTIVE_PALETTE_SIZE } from "../config/constants.js";
import { RETRO_PALETTES } from "../config/palettes.js";

const HEX_RE = /^#[0-9A-F]{6}$/;

test("every retro palette has exactly 16 colors (padded if source is shorter)", () => {
  for (const p of RETRO_PALETTES) {
    assert.equal(
      p.colors.length,
      ACTIVE_PALETTE_SIZE,
      `${p.id} should have ${ACTIVE_PALETTE_SIZE} colors, has ${p.colors.length}`,
    );
  }
});

test("every retro palette color is a valid uppercase #RRGGBB hex", () => {
  for (const p of RETRO_PALETTES) {
    for (const c of p.colors) {
      assert.match(c, HEX_RE, `${p.id} has invalid hex ${c}`);
    }
  }
});

test("retro palette ids are unique and kebab-case", () => {
  const seen = new Set<string>();
  for (const p of RETRO_PALETTES) {
    assert.equal(seen.has(p.id), false, `duplicate id ${p.id}`);
    seen.add(p.id);
    assert.match(p.id, /^[a-z0-9-]+$/, `non-kebab id ${p.id}`);
  }
});

test('"default" is not used as a retro id (reserved for the EGA-mapped baseline)', () => {
  for (const p of RETRO_PALETTES) {
    assert.notEqual(p.id, "default");
  }
});

test("ZX Spectrum is padded by repeating Bright White", () => {
  const zx = RETRO_PALETTES.find((p) => p.id === "zx-spectrum");
  assert.ok(zx);
  assert.equal(zx.colors.length, ACTIVE_PALETTE_SIZE);
  // Source has 15 distinct colors ending in Bright White (#FFFFFF). Padding
  // repeats the last entry so slot 15 is still #FFFFFF.
  assert.equal(zx.colors[14], "#FFFFFF");
  assert.equal(zx.colors[15], "#FFFFFF");
});

test("TMS 9918 is padded by repeating White (no transparent slot at the palette level)", () => {
  const tms = RETRO_PALETTES.find((p) => p.id === "tms9918");
  assert.ok(tms);
  assert.equal(tms.colors.length, ACTIVE_PALETTE_SIZE);
  assert.equal(tms.colors[14], "#FFFFFF");
  assert.equal(tms.colors[15], "#FFFFFF");
});

test("all six expected palettes ship, in a stable order", () => {
  assert.deepEqual(
    RETRO_PALETTES.map((p) => p.id),
    ["c64", "vic20", "zx-spectrum", "ega", "intellivision", "tms9918"],
  );
});
