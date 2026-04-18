import { Bitmap, TRANSPARENT } from "./bitmap.js";

export type ToolId = "pixel" | "erase" | "fill";

// Paints a single pixel. Returns the replaced value, or null if unchanged.
export function drawPixel(
  b: Bitmap,
  x: number,
  y: number,
  value: number,
): number | null {
  const prev = b.get(x, y);
  if (prev === value) return null;
  b.set(x, y, value);
  return prev;
}

// Flood-fill starting at (x, y). Returns a clone of the bitmap before the
// fill (for undo), or null if the fill was a no-op.
export function fillArea(
  b: Bitmap,
  x: number,
  y: number,
  value: number,
): Bitmap | null {
  const target = b.get(x, y);
  if (target === value) return null;
  const before = b.clone();
  const stack: Array<[number, number]> = [[x, y]];
  while (stack.length > 0) {
    const [cx, cy] = stack.pop()!;
    if (cx < 0 || cy < 0 || cx >= b.width || cy >= b.height) continue;
    if (b.get(cx, cy) !== target) continue;
    b.set(cx, cy, value);
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  return before;
}

// Shifts pixels one column right (wraparound).
export function shiftRight(b: Bitmap): void {
  for (let y = 0; y < b.height; y++) {
    const last = b.get(b.width - 1, y);
    for (let x = b.width - 1; x > 0; x--) b.set(x, y, b.get(x - 1, y));
    b.set(0, y, last);
  }
}

// Shifts pixels one row up (wraparound).
export function shiftUp(b: Bitmap): void {
  for (let x = 0; x < b.width; x++) {
    const first = b.get(x, 0);
    for (let y = 0; y < b.height - 1; y++) b.set(x, y, b.get(x, y + 1));
    b.set(x, b.height - 1, first);
  }
}

export function flipHorizontal(b: Bitmap): void {
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < Math.floor(b.width / 2); x++) {
      const a = b.get(x, y);
      b.set(x, y, b.get(b.width - 1 - x, y));
      b.set(b.width - 1 - x, y, a);
    }
  }
}

export function flipVertical(b: Bitmap): void {
  for (let x = 0; x < b.width; x++) {
    for (let y = 0; y < Math.floor(b.height / 2); y++) {
      const a = b.get(x, y);
      b.set(x, y, b.get(x, b.height - 1 - y));
      b.set(x, b.height - 1 - y, a);
    }
  }
}

// Rotates 90° counter-clockwise (matches legacy behavior).
export function rotateLeft(b: Bitmap): void {
  const src = b.clone();
  for (let x = 0; x < b.width; x++) {
    for (let y = 0; y < b.height; y++) {
      b.set(x, y, src.get(src.height - 1 - y, x));
    }
  }
}

export function clearAll(b: Bitmap): void {
  b.data.fill(TRANSPARENT);
}
