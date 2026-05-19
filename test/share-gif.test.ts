import { strict as assert } from "node:assert";
import { test } from "node:test";
// @ts-expect-error omggif ships no TS types
import { GifReader } from "omggif";
import { Bitmap, TRANSPARENT } from "../src/editor/bitmap.js";
import { encodeShareGif, SHARE_H, SHARE_W } from "../src/editor/share-gif.js";
import {
  DEFAULT_ACTIVE_PALETTE,
  activePaletteToRgb,
} from "../src/editor/palette.js";

interface Reader {
  width: number;
  height: number;
  numFrames(): number;
  frameInfo(i: number): { delay: number };
  decodeAndBlitFrameRGBA(i: number, out: Uint8Array): void;
}

function read(bytes: Uint8Array): Reader {
  return new GifReader(bytes) as Reader;
}

function rgbaAt(rgba: Uint8Array, width: number, x: number, y: number): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

test("emits a valid 960×960 GIF for a single-frame drawing", () => {
  const b = new Bitmap();
  b.set(5, 5, 3);
  const bytes = encodeShareGif({
    frames: [b],
    activePalette: DEFAULT_ACTIVE_PALETTE,
  });
  const r = read(bytes);
  assert.equal(r.width, SHARE_W);
  assert.equal(r.height, SHARE_H);
  assert.equal(r.numFrames(), 1);
  assert.ok(bytes.length < 200_000, `share gif unexpectedly large: ${bytes.length} bytes`);
});

test("preserves frame count + delay for animated drawings", () => {
  const frames = Array.from({ length: 4 }, (_, i) => {
    const f = new Bitmap();
    f.set(i, 0, 1);
    return f;
  });
  const bytes = encodeShareGif({
    frames,
    activePalette: DEFAULT_ACTIVE_PALETTE,
    delayMs: 200,
  });
  const r = read(bytes);
  assert.equal(r.numFrames(), 4);
  assert.equal(r.frameInfo(0).delay, 20);
});

test("renders one swatch per used color, none for unused colors, sorted dark→light", () => {
  // Use slots 2 (blue), 5 (bright green), 7 (cyan).
  const frame = new Bitmap();
  frame.set(0, 0, 2);
  frame.set(1, 0, 5);
  frame.set(2, 0, 7);

  const bytes = encodeShareGif({
    frames: [frame],
    activePalette: DEFAULT_ACTIVE_PALETTE,
  });
  const r = read(bytes);
  const rgba = new Uint8Array(r.width * r.height * 4);
  r.decodeAndBlitFrameRGBA(0, rgba);

  const palette = activePaletteToRgb(DEFAULT_ACTIVE_PALETTE);
  // Sort the input by ITU-R BT.709 luminance, ascending; assert the
  // swatch columns match that order, not the slot-index order.
  const rel = (rgb: typeof palette[number]) =>
    0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const usedSortedDarkToLight = [2, 5, 7].sort((a, b) => rel(palette[a]) - rel(palette[b]));

  // Swatch layout: SWATCH_X=24, SWATCH_Y=24, SWATCH_SIZE=18, gutter=3.
  usedSortedDarkToLight.forEach((slot, col) => {
    const cx = 24 + col * 21 + 9; // center of swatch
    const cy = 24 + 9;
    const [r0, g0, b0] = palette[slot];
    const [pr, pg, pb] = rgbaAt(rgba, r.width, cx, cy);
    assert.equal(pr, r0, `swatch col=${col} slot=${slot} red`);
    assert.equal(pg, g0, `swatch col=${col} slot=${slot} green`);
    assert.equal(pb, b0, `swatch col=${col} slot=${slot} blue`);
  });

  // Beyond the 3rd swatch the chrome shows the derived background. Sample
  // a pixel where col=4 would be (well past the rendered swatch row).
  const [bgR, bgG, bgB, bgA] = rgbaAt(rgba, r.width, 24 + 4 * 21 + 9, 24 + 9);
  assert.equal(bgA, 255);
  for (const s of usedSortedDarkToLight) {
    const [r0, g0, b0] = palette[s];
    assert.ok(
      !(bgR === r0 && bgG === g0 && bgB === b0),
      `bg should differ from used slot ${s}`,
    );
  }
});

test("renders the logo in the bottom-right corner", () => {
  const frame = new Bitmap();
  frame.set(0, 0, 1);
  const bytes = encodeShareGif({
    frames: [frame],
    activePalette: DEFAULT_ACTIVE_PALETTE,
  });
  const r = read(bytes);
  const rgba = new Uint8Array(r.width * r.height * 4);
  r.decodeAndBlitFrameRGBA(0, rgba);

  // Logo origin is at (810, 888). The first column of the wordmark is
  // entirely ink (the "D"'s left edge); sample mid-glyph and assert the
  // pixel differs from the bg sampled far from any chrome.
  const inkPx = rgbaAt(rgba, r.width, 810, 888);
  const bgPx = rgbaAt(rgba, r.width, 720, 720);
  assert.notDeepEqual([inkPx[0], inkPx[1], inkPx[2]], [bgPx[0], bgPx[1], bgPx[2]]);
});

test("handles a fully-transparent drawing via the fallback background", () => {
  const blank = new Bitmap();
  // All TRANSPARENT by default — leave it alone.
  for (const v of blank.data) assert.equal(v, TRANSPARENT);
  const bytes = encodeShareGif({
    frames: [blank],
    activePalette: DEFAULT_ACTIVE_PALETTE,
  });
  const r = read(bytes);
  assert.equal(r.numFrames(), 1);
  const rgba = new Uint8Array(r.width * r.height * 4);
  r.decodeAndBlitFrameRGBA(0, rgba);

  // Center pixel should be the fallback bg [40, 50, 60].
  const [cr, cg, cb, ca] = rgbaAt(rgba, r.width, 480, 480);
  assert.equal(ca, 255);
  assert.equal(cr, 40);
  assert.equal(cg, 50);
  assert.equal(cb, 60);
});

test("rejects empty / oversized / wrong-shape input", () => {
  assert.throws(
    () => encodeShareGif({ frames: [], activePalette: DEFAULT_ACTIVE_PALETTE }),
    /no frames/,
  );
  const tooMany = Array.from({ length: 17 }, () => new Bitmap());
  assert.throws(
    () => encodeShareGif({ frames: tooMany, activePalette: DEFAULT_ACTIVE_PALETTE }),
    /too many/,
  );
  assert.throws(
    () => encodeShareGif({ frames: [new Bitmap()], activePalette: new Uint8Array(8) }),
    /active palette/,
  );
});
