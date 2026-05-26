import { contentHash, hashHex } from "../src/proof-of-work.js";

// A "canvas" is a personal drawing: an ordered cols×rows grid of 16×16 tiles.
// Every drawing is a canvas (a plain 16×16 is a 1×1 canvas). The canvas id is
// content-addressed from the canonical manifest, mirroring how a tile/drawing
// id is sha256 of its gif bytes.

export const CANVAS_MAX_COLS = 4;
export const CANVAS_MAX_ROWS = 4;
export const CANVAS_MAX_TILES = CANVAS_MAX_COLS * CANVAS_MAX_ROWS;

const TILE_ID_RE = /^[0-9a-f]{64}$/;
const CANVAS_ID_RE = /^[0-9a-f]{64}$/;
// Sentinel for an empty cell in the canonical preimage. Distinct from a 64-hex
// id and from an empty line, so the serialization is unambiguous.
const EMPTY_CELL = "-";

export interface CanvasManifest {
  cols: number;
  rows: number;
  // Row-major, length === cols*rows. null = empty cell.
  tiles: (string | null)[];
}

export function isCanvasIdValid(id: string): boolean {
  return CANVAS_ID_RE.test(id);
}

export function isCanvasShapeValid(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 1 &&
    rows >= 1 &&
    cols <= CANVAS_MAX_COLS &&
    rows <= CANVAS_MAX_ROWS
  );
}

// Valid shape, correct tile-array length, every non-empty cell a 64-hex id, and
// at least one filled cell (an all-empty canvas isn't a drawing).
export function isManifestValid(m: CanvasManifest): boolean {
  if (!isCanvasShapeValid(m.cols, m.rows)) return false;
  if (!Array.isArray(m.tiles) || m.tiles.length !== m.cols * m.rows) return false;
  let filled = 0;
  for (const t of m.tiles) {
    if (t === null) continue;
    if (typeof t !== "string" || !TILE_ID_RE.test(t)) return false;
    filled++;
  }
  return filled > 0;
}

// Deterministic, unambiguous preimage for the content-addressed canvas id.
// Line 1: version tag. Line 2: "<cols>x<rows>". Then cols*rows lines, row-major,
// each a 64-hex tile id or "-" for an empty cell.
export function canonicalCanvasString(m: CanvasManifest): string {
  const lines = ["drawbang-canvas/v1", `${m.cols}x${m.rows}`];
  for (const t of m.tiles) lines.push(t === null ? EMPTY_CELL : t);
  return lines.join("\n");
}

export async function canvasIdFor(m: CanvasManifest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalCanvasString(m));
  return hashHex(await contentHash(bytes));
}

export function cellIndex(x: number, y: number, cols: number): number {
  return y * cols + x;
}
