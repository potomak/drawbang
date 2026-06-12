import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { ACTIVE_PALETTE_SIZE } from "../config/constants.js";
import { padPalette } from "../config/palettes.js";
import {
  lospecPaletteUrl,
  normalizeHex,
  parseImportInput,
  parseLospecJson,
} from "../src/editor/lospec.js";
import { BASE_PALETTE, hexToRgb, nearestBaseIndex } from "../src/editor/palette.js";

describe("normalizeHex", () => {
  test("canonicalizes 6-digit hex with or without #", () => {
    assert.equal(normalizeHex("#1a2b3c"), "#1a2b3c");
    assert.equal(normalizeHex("1A2B3C"), "#1a2b3c");
  });

  test("expands 3-digit shorthand", () => {
    assert.equal(normalizeHex("abc"), "#aabbcc");
    assert.equal(normalizeHex("#F0F"), "#ff00ff");
  });

  test("rejects non-hex input", () => {
    assert.equal(normalizeHex("xyzxyz"), null);
    assert.equal(normalizeHex("12345"), null);
    assert.equal(normalizeHex("#1234567"), null);
    assert.equal(normalizeHex(""), null);
  });
});

describe("parseImportInput", () => {
  test("a bare slug", () => {
    assert.deepEqual(parseImportInput("sweetie-16"), {
      kind: "slug",
      slug: "sweetie-16",
    });
  });

  test("slugs are trimmed and lowercased", () => {
    assert.deepEqual(parseImportInput("  SWEETIE-16  "), {
      kind: "slug",
      slug: "sweetie-16",
    });
  });

  test("a full lospec.com palette URL", () => {
    assert.deepEqual(
      parseImportInput("https://lospec.com/palette-list/sweetie-16"),
      { kind: "slug", slug: "sweetie-16" },
    );
  });

  test("a lospec.com URL with .json suffix keeps just the slug", () => {
    assert.deepEqual(
      parseImportInput("https://lospec.com/palette-list/aap-64.json"),
      { kind: "slug", slug: "aap-64" },
    );
  });

  test("a whitespace-separated hex list (Lospec HEX file paste, no #)", () => {
    assert.deepEqual(parseImportInput("1a1c2c 5d275d b13e53"), {
      kind: "colors",
      colors: ["#1a1c2c", "#5d275d", "#b13e53"],
    });
  });

  test("comma- and newline-separated hex lists", () => {
    assert.deepEqual(parseImportInput("#1a1c2c,#5d275d\n#b13e53"), {
      kind: "colors",
      colors: ["#1a1c2c", "#5d275d", "#b13e53"],
    });
  });

  test("a single all-hex bare token reads as a slug; # forces the color", () => {
    assert.deepEqual(parseImportInput("fabada"), { kind: "slug", slug: "fabada" });
    assert.deepEqual(parseImportInput("#fabada"), {
      kind: "colors",
      colors: ["#fabada"],
    });
  });

  test("rejects empty input and mixed garbage", () => {
    assert.equal(parseImportInput(""), null);
    assert.equal(parseImportInput("   "), null);
    assert.equal(parseImportInput("1a1c2c not-hex"), null);
    assert.equal(parseImportInput("!!!"), null);
  });
});

describe("parseLospecJson", () => {
  test("normalizes the #-less hex entries Lospec returns", () => {
    const parsed = parseLospecJson(
      { name: "Sweetie 16", author: "GrafxKid", colors: ["1a1c2c", "5D275D"] },
      "sweetie-16",
    );
    assert.equal(parsed.name, "Sweetie 16");
    assert.deepEqual(parsed.colors, ["#1a1c2c", "#5d275d"]);
  });

  test("falls back to the slug when the name is missing or blank", () => {
    const parsed = parseLospecJson({ colors: ["1a1c2c"] }, "sweetie-16");
    assert.equal(parsed.name, "sweetie-16");
    assert.equal(parseLospecJson({ name: "  ", colors: ["1a1c2c"] }, "x").name, "x");
  });

  test("rejects malformed responses", () => {
    assert.throws(() => parseLospecJson(null, "x"));
    assert.throws(() => parseLospecJson("nope", "x"));
    assert.throws(() => parseLospecJson({}, "x"));
    assert.throws(() => parseLospecJson({ colors: [] }, "x"));
    assert.throws(() => parseLospecJson({ colors: ["zzz"] }, "x"));
    assert.throws(() => parseLospecJson({ colors: [42] }, "x"));
  });
});

describe("imported palette → active palette quantization", () => {
  test("padPalette repeats the last color up to 16 and truncates past 16", () => {
    const short = padPalette(["#111111", "#222222"]);
    assert.equal(short.length, ACTIVE_PALETTE_SIZE);
    assert.equal(short[15], "#222222");

    const long = padPalette(Array.from({ length: 20 }, (_, i) => `#0000${String(i).padStart(2, "0")}`));
    assert.equal(long.length, ACTIVE_PALETTE_SIZE);
  });

  test("exact base-palette colors snap to themselves", () => {
    // [0,0,0] and [255,255,255] both exist in the base palette.
    for (const hex of ["#000000", "#ffffff"]) {
      const idx = nearestBaseIndex(hexToRgb(hex));
      const [r, g, b] = BASE_PALETTE[idx];
      assert.deepEqual([r, g, b], hexToRgb(hex));
    }
  });

  test("arbitrary colors snap to the minimal-distance base entry", () => {
    // Sweetie-16 sample colors — none are exact base entries.
    for (const hex of ["#1a1c2c", "#b13e53", "#ffcd75", "#41a6f6"]) {
      const rgb = hexToRgb(hex);
      const idx = nearestBaseIndex(rgb);
      const dist = (i: number): number => {
        const [r, g, b] = BASE_PALETTE[i];
        return (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
      };
      const best = Math.min(...BASE_PALETTE.map((_, i) => dist(i)));
      assert.equal(dist(idx), best, hex);
    }
  });
});

test("lospecPaletteUrl points at the public JSON endpoint", () => {
  assert.equal(
    lospecPaletteUrl("sweetie-16"),
    "https://lospec.com/palette-list/sweetie-16.json",
  );
});
