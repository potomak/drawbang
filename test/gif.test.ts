import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Bitmap, TRANSPARENT } from "../src/editor/bitmap.js";
import { decodeGif, encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";

test("encode a single-frame gif at 16x16 with the default palette", () => {
  const b = new Bitmap();
  for (let x = 0; x < 16; x++) b.set(x, 8, 3); // one slot-3 row
  const bytes = encodeGif({ frames: [b], activePalette: DEFAULT_ACTIVE_PALETTE });
  assert.ok(bytes.length > 0 && bytes.length < 2048, `gif length ${bytes.length}`);
  assert.equal(bytes[bytes.length - 1], 0x3b, "last byte should be GIF trailer");
  // header + LSD + size
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 6)), "GIF89a");
  assert.equal(bytes[6] | (bytes[7] << 8), 16);
  assert.equal(bytes[8] | (bytes[9] << 8), 16);
});

test("round-trip: encode then decode returns identical frame data and palette", () => {
  const frame = new Bitmap();
  // A diagonal stripe and some transparent pixels.
  for (let i = 0; i < 16; i++) frame.set(i, i, 5);
  frame.set(0, 0, TRANSPARENT);

  // Use a custom palette: flip two slots to verify palette round-trip.
  const palette = new Uint8Array(DEFAULT_ACTIVE_PALETTE);
  palette[1] = 100; // arbitrary base-palette slot
  palette[5] = 200;

  const bytes = encodeGif({ frames: [frame], activePalette: palette });
  const decoded = decodeGif(bytes);

  assert.equal(decoded.frames.length, 1);
  assert.ok(decoded.activePalette, "DRAWBANG extension should be present");
  assert.deepEqual(Array.from(decoded.activePalette!), Array.from(palette));
  assert.deepEqual(Array.from(decoded.frames[0].data), Array.from(frame.data));
});

test("round-trip: multiple frames", () => {
  const frames = Array.from({ length: 4 }, (_, i) => {
    const b = new Bitmap();
    b.set(i, i, i + 1);
    return b;
  });
  const bytes = encodeGif({ frames, activePalette: DEFAULT_ACTIVE_PALETTE });
  const decoded = decodeGif(bytes);
  assert.equal(decoded.frames.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(decoded.frames[i].get(i, i), i + 1);
  }
});

test("decode rejects garbage input", () => {
  const notAGif = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x3b]);
  assert.throws(() => decodeGif(notAGif));
});
