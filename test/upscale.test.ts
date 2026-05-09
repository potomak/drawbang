import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Bitmap, TRANSPARENT } from "../src/editor/bitmap.js";
import { DEFAULT_ACTIVE_PALETTE, activePaletteToRgb } from "../src/editor/palette.js";
import { upscaleBitmapToSvg } from "../merch/upscale.js";

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function rgbHex([r, g, b]: readonly [number, number, number]): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

test("upscale: emits an SVG sized to the requested px and a 16×16 viewBox", () => {
  const b = new Bitmap();
  const svg = decode(upscaleBitmapToSvg(b, DEFAULT_ACTIVE_PALETTE, { sizePx: 32 }));
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /\bwidth="32"/);
  assert.match(svg, /\bheight="32"/);
  assert.match(svg, /\bviewBox="0 0 16 16"/);
  assert.match(svg, /\bshape-rendering="crispEdges"/);
});

test("upscale: emits a fill rect per non-transparent source pixel", () => {
  const b = new Bitmap();
  b.set(2, 3, 5);
  b.set(7, 7, 9);
  const svg = decode(upscaleBitmapToSvg(b, DEFAULT_ACTIVE_PALETTE, { sizePx: 1600 }));
  const colors = activePaletteToRgb(DEFAULT_ACTIVE_PALETTE);
  // Two filled cells -> exactly two <rect ... fill=...> entries (background
  // null => no full-canvas backdrop).
  const rects = svg.match(/<rect[^/]*\/>/g) ?? [];
  assert.equal(rects.length, 2);
  assert.ok(svg.includes(`<rect x="2" y="3" width="1" height="1" fill="${rgbHex(colors[5])}"/>`));
  assert.ok(svg.includes(`<rect x="7" y="7" width="1" height="1" fill="${rgbHex(colors[9])}"/>`));
});

test("upscale: skips transparent pixels when background is null", () => {
  const b = new Bitmap();
  b.set(0, 0, TRANSPARENT);
  const svg = decode(upscaleBitmapToSvg(b, DEFAULT_ACTIVE_PALETTE, { sizePx: 32 }));
  // No <rect> at all — fully transparent bitmap with no backdrop.
  assert.equal(svg.match(/<rect/g), null);
});

test("upscale: emits a single full-canvas backdrop rect when background is set", () => {
  const b = new Bitmap();
  const svg = decode(
    upscaleBitmapToSvg(b, DEFAULT_ACTIVE_PALETTE, { sizePx: 32, background: [12, 34, 56] }),
  );
  const rects = svg.match(/<rect[^/]*\/>/g) ?? [];
  assert.equal(rects.length, 1);
  assert.ok(svg.includes(`<rect width="16" height="16" fill="#0c2238"/>`));
});

test("upscale: rejects sizePx that is not a multiple of 16", () => {
  const b = new Bitmap();
  assert.throws(
    () => upscaleBitmapToSvg(b, DEFAULT_ACTIVE_PALETTE, { sizePx: 33 }),
    /multiple of bitmap dims/,
  );
});

test("upscale: rejects non-positive sizePx", () => {
  const b = new Bitmap();
  assert.throws(
    () => upscaleBitmapToSvg(b, DEFAULT_ACTIVE_PALETTE, { sizePx: 0 }),
    /positive integer/,
  );
});

test("upscale: SVG size is bounded by rect count, not sizePx (memory regression test)", () => {
  // The whole point of the SVG path: a 4000px output for an all-filled
  // 16×16 source should still produce a tiny payload, because the SVG is
  // 256 rects regardless of sizePx.
  const b = new Bitmap();
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) b.set(x, y, (x + y) & 7);
  const bytes = upscaleBitmapToSvg(b, DEFAULT_ACTIVE_PALETTE, { sizePx: 4000 });
  // ~70 chars per rect × 256 rects ≈ 18KB. Bound generously at 32KB to leave
  // headroom for hex-color or attribute formatting tweaks.
  assert.ok(
    bytes.byteLength < 32_000,
    `SVG bytes ${bytes.byteLength} unexpectedly large at sizePx=4000`,
  );
});
