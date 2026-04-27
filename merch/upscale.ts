import { PNG } from "pngjs";
import { Bitmap, TRANSPARENT } from "../src/editor/bitmap.js";
import { activePaletteToRgb } from "../src/editor/palette.js";

export interface UpscaleOptions {
  sizePx: number;
  background?: [number, number, number] | null;
}

export async function upscaleBitmapToPng(
  bitmap: Bitmap,
  activePalette: Uint8Array,
  opts: UpscaleOptions,
): Promise<Uint8Array> {
  const { sizePx } = opts;
  const background = opts.background ?? null;

  if (!Number.isInteger(sizePx) || sizePx <= 0) {
    throw new Error(`sizePx must be a positive integer, got ${sizePx}`);
  }
  if (sizePx % bitmap.width !== 0 || sizePx % bitmap.height !== 0) {
    throw new Error(
      `sizePx (${sizePx}) must be a multiple of bitmap dims (${bitmap.width}x${bitmap.height})`,
    );
  }

  const colors = activePaletteToRgb(activePalette);
  const blockX = sizePx / bitmap.width;
  const blockY = sizePx / bitmap.height;
  const png = new PNG({ width: sizePx, height: sizePx });
  const data = png.data;

  for (let sy = 0; sy < bitmap.height; sy++) {
    for (let sx = 0; sx < bitmap.width; sx++) {
      const idx = bitmap.get(sx, sy);
      let r: number, g: number, b: number, a: number;
      if (idx === TRANSPARENT) {
        if (background === null) {
          r = 0; g = 0; b = 0; a = 0;
        } else {
          [r, g, b] = background;
          a = 255;
        }
      } else {
        [r, g, b] = colors[idx];
        a = 255;
      }
      const x0 = sx * blockX;
      const y0 = sy * blockY;
      for (let py = 0; py < blockY; py++) {
        let off = ((y0 + py) * sizePx + x0) * 4;
        for (let px = 0; px < blockX; px++) {
          data[off++] = r;
          data[off++] = g;
          data[off++] = b;
          data[off++] = a;
        }
      }
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    png.pack()
      .on("data", (chunk: Buffer) => chunks.push(chunk))
      .on("end", () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let p = 0;
        for (const c of chunks) {
          out.set(c, p);
          p += c.length;
        }
        resolve(out);
      })
      .on("error", reject);
  });
}
