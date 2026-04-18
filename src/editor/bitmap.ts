import { WIDTH, HEIGHT, ACTIVE_PALETTE_SIZE } from "../../config/constants.js";

// Pixel states:
//   0..15 -> active-palette slot (see palette.ts)
//   16    -> transparent
// Anything else is invalid.
export const TRANSPARENT = ACTIVE_PALETTE_SIZE; // 16
export const PIXEL_STATES = ACTIVE_PALETTE_SIZE + 1; // 17

export class Bitmap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width = WIDTH, height = HEIGHT, data?: Uint8Array) {
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8Array(width * height).fill(TRANSPARENT);
    if (this.data.length !== width * height) {
      throw new Error(`bitmap data length ${this.data.length} != ${width * height}`);
    }
  }

  get(x: number, y: number): number {
    return this.data[y * this.width + x];
  }

  set(x: number, y: number, value: number): void {
    if (value < 0 || value >= PIXEL_STATES) {
      throw new Error(`invalid pixel state ${value}`);
    }
    this.data[y * this.width + x] = value;
  }

  clone(): Bitmap {
    return new Bitmap(this.width, this.height, new Uint8Array(this.data));
  }

  clear(): void {
    this.data.fill(TRANSPARENT);
  }

  static fromArray(data: Uint8Array | number[], w = WIDTH, h = HEIGHT): Bitmap {
    return new Bitmap(w, h, new Uint8Array(data));
  }
}
