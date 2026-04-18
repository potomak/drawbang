import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Bitmap, TRANSPARENT } from "../src/editor/bitmap.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { decodeShare, encodeShare } from "../src/share.js";

test("share codec round-trips a single-frame bitmap", () => {
  const frame = new Bitmap();
  for (let i = 0; i < 16; i++) frame.set(i, 0, i);
  frame.set(5, 5, TRANSPARENT);

  const enc = encodeShare({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });
  const dec = decodeShare(enc);
  assert.equal(dec.frames.length, 1);
  assert.deepEqual(Array.from(dec.frames[0].data), Array.from(frame.data));
  assert.deepEqual(Array.from(dec.activePalette), Array.from(DEFAULT_ACTIVE_PALETTE));
});

test("share codec round-trips 16 frames", () => {
  const frames = Array.from({ length: 16 }, (_, i) => {
    const b = new Bitmap();
    b.set(i, i, (i % 16) as number);
    return b;
  });
  const enc = encodeShare({ frames, activePalette: DEFAULT_ACTIVE_PALETTE });
  const dec = decodeShare(enc);
  assert.equal(dec.frames.length, 16);
  for (let i = 0; i < 16; i++) {
    assert.equal(dec.frames[i].get(i, i), i % 16);
  }
});

test("share codec size is under 4KB for 16 frames", () => {
  const frames = Array.from({ length: 16 }, () => new Bitmap());
  const enc = encodeShare({ frames, activePalette: DEFAULT_ACTIVE_PALETTE });
  assert.ok(enc.length < 4096, `encoded length ${enc.length}`);
});
