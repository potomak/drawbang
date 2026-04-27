import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PNG } from "pngjs";
import { Bitmap, TRANSPARENT } from "../src/editor/bitmap.js";
import { DEFAULT_ACTIVE_PALETTE, activePaletteToRgb } from "../src/editor/palette.js";
import { upscaleBitmapToPng } from "../merch/upscale.js";

function decodePng(bytes: Uint8Array): PNG {
  return PNG.sync.read(Buffer.from(bytes));
}

function readPixel(png: PNG, x: number, y: number): [number, number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

test("upscale: produces a square RGBA PNG of the requested size", async () => {
  const b = new Bitmap();
  const bytes = await upscaleBitmapToPng(b, DEFAULT_ACTIVE_PALETTE, { sizePx: 32 });
  const png = decodePng(bytes);
  assert.equal(png.width, 32);
  assert.equal(png.height, 32);
});

test("upscale: each source pixel becomes a uniform N×N block of the palette color", async () => {
  const b = new Bitmap();
  // Slot 5 -> a known RGB via the active palette
  b.set(2, 3, 5);
  const sizePx = 64; // block = 4
  const bytes = await upscaleBitmapToPng(b, DEFAULT_ACTIVE_PALETTE, { sizePx });
  const png = decodePng(bytes);
  const colors = activePaletteToRgb(DEFAULT_ACTIVE_PALETTE);
  const [r, g, b5] = colors[5];
  const block = sizePx / 16;
  // Sample every pixel inside the (2,3) block; all must equal slot 5 RGBA
  for (let py = 0; py < block; py++) {
    for (let px = 0; px < block; px++) {
      const x = 2 * block + px;
      const y = 3 * block + py;
      assert.deepEqual(readPixel(png, x, y), [r, g, b5, 255], `pixel at (${x},${y})`);
    }
  }
  // A neighboring block (1,3) should be transparent (default bg)
  assert.deepEqual(readPixel(png, 1 * block, 3 * block), [0, 0, 0, 0]);
});

test("upscale: transparent pixels stay transparent when background is null", async () => {
  const b = new Bitmap();
  // All transparent by default; explicitly set one for clarity
  b.set(0, 0, TRANSPARENT);
  const bytes = await upscaleBitmapToPng(b, DEFAULT_ACTIVE_PALETTE, { sizePx: 32 });
  const png = decodePng(bytes);
  assert.deepEqual(readPixel(png, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(readPixel(png, 31, 31), [0, 0, 0, 0]);
});

test("upscale: transparent pixels take the background RGB at full alpha when provided", async () => {
  const b = new Bitmap();
  const bytes = await upscaleBitmapToPng(b, DEFAULT_ACTIVE_PALETTE, {
    sizePx: 32,
    background: [12, 34, 56],
  });
  const png = decodePng(bytes);
  assert.deepEqual(readPixel(png, 0, 0), [12, 34, 56, 255]);
  assert.deepEqual(readPixel(png, 31, 31), [12, 34, 56, 255]);
});

test("upscale: rejects sizePx that is not a multiple of 16", async () => {
  const b = new Bitmap();
  await assert.rejects(
    () => upscaleBitmapToPng(b, DEFAULT_ACTIVE_PALETTE, { sizePx: 33 }),
    /multiple of bitmap dims/,
  );
});

test("upscale: rejects non-positive sizePx", async () => {
  const b = new Bitmap();
  await assert.rejects(
    () => upscaleBitmapToPng(b, DEFAULT_ACTIVE_PALETTE, { sizePx: 0 }),
    /positive integer/,
  );
});
