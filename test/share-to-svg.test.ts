import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Bitmap, TRANSPARENT } from "../src/editor/bitmap.js";
import { DEFAULT_ACTIVE_PALETTE, activePaletteToHex } from "../src/editor/palette.js";
import { encodeShare } from "../src/share.js";
import { shareToSvg } from "../src/share-to-svg.js";

function tinyDrawing(): { share: string; hex: string[] } {
  // Single frame: pixel (0,0) = slot 1, (1,0) = slot 2, everything else
  // transparent. Lets the test assert exact rect output.
  const data = new Uint8Array(16 * 16).fill(TRANSPARENT);
  data[0] = 1;
  data[1] = 2;
  const frame = Bitmap.fromArray(data);
  const share = encodeShare({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });
  return { share, hex: activePaletteToHex(DEFAULT_ACTIVE_PALETTE) };
}

test("shareToSvg: emits a 16x16 viewBox and one rect per colored pixel", () => {
  const { share, hex } = tinyDrawing();
  const svg = shareToSvg(share);
  assert.match(svg, /viewBox="0 0 16 16"/);
  assert.match(svg, /width="16"/);
  assert.match(svg, /height="16"/);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.ok(svg.includes(`<rect x="0" y="0" width="1" height="1" fill="${hex[1]}"/>`));
  assert.ok(svg.includes(`<rect x="1" y="0" width="1" height="1" fill="${hex[2]}"/>`));
  // Only the two colored pixels become rects (plus the outer <svg>); no
  // background rect when `background` is unset.
  const rectCount = (svg.match(/<rect /g) ?? []).length;
  assert.equal(rectCount, 2);
});

test("shareToSvg: --size overrides the rendered width/height (viewBox stays 16)", () => {
  const { share } = tinyDrawing();
  const svg = shareToSvg(share, { size: 128 });
  assert.match(svg, /viewBox="0 0 16 16"/);
  assert.match(svg, /width="128"/);
  assert.match(svg, /height="128"/);
});

test("shareToSvg: background option lays down a full-canvas rect first", () => {
  const { share } = tinyDrawing();
  const svg = shareToSvg(share, { background: "#0a0a0a" });
  assert.match(svg, /<rect width="16" height="16" fill="#0a0a0a"\/>/);
  const rectCount = (svg.match(/<rect /g) ?? []).length;
  assert.equal(rectCount, 3); // background + two colored pixels
});

test("shareToSvg: accepts the bare base64url code, a fragment, and a full URL", () => {
  const { share } = tinyDrawing();
  const direct = shareToSvg(share);
  const fragment = shareToSvg(`#d=${share}`);
  const fullUrl = shareToSvg(`https://drawbang.cool/#d=${share}`);
  const queryUrl = shareToSvg(`https://drawbang.cool/share?d=${share}`);
  assert.equal(direct, fragment);
  assert.equal(direct, fullUrl);
  assert.equal(direct, queryUrl);
});

test("shareToSvg: rejects garbage input", () => {
  assert.throws(() => shareToSvg("not a share link!"), /could not extract share code/);
});

test("shareToSvg: renders only the first frame", () => {
  // Frame 0: single pixel at (0,0). Frame 1: single pixel at (15,15).
  // SVG output must reflect frame 0 only.
  const d0 = new Uint8Array(16 * 16).fill(TRANSPARENT);
  d0[0] = 3;
  const d1 = new Uint8Array(16 * 16).fill(TRANSPARENT);
  d1[16 * 15 + 15] = 7;
  const share = encodeShare({
    frames: [Bitmap.fromArray(d0), Bitmap.fromArray(d1)],
    activePalette: DEFAULT_ACTIVE_PALETTE,
  });
  const svg = shareToSvg(share);
  assert.ok(svg.includes(`x="0" y="0"`));
  assert.ok(!svg.includes(`x="15" y="15"`));
});
