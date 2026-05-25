import { Bitmap, TRANSPARENT } from "./bitmap.js";
import { CANVAS_MAX_COLS, CANVAS_MAX_ROWS } from "../../config/canvas.js";

// In-editor model for a multi-tile drawing ("canvas"). Each cell holds its own
// 16×16 frame stack; the editor edits one active cell at a time via the
// existing FrameState, swapping cell contents in/out on navigation. Cells are
// keyed by "x,y" so growing the grid never reindexes existing cells.

export interface CanvasDoc {
  cols: number;
  rows: number;
  activeX: number;
  activeY: number;
  cells: Map<string, Bitmap[]>;
}

export function createCanvasDoc(): CanvasDoc {
  return { cols: 1, rows: 1, activeX: 0, activeY: 0, cells: new Map() };
}

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function getCell(d: CanvasDoc, x: number, y: number): Bitmap[] | undefined {
  return d.cells.get(cellKey(x, y));
}

export function setCell(d: CanvasDoc, x: number, y: number, frames: Bitmap[]): void {
  d.cells.set(cellKey(x, y), frames);
}

export function framesEmpty(frames: Bitmap[]): boolean {
  return frames.every((f) => f.data.every((p) => p === TRANSPARENT));
}

export function canGrowCols(d: CanvasDoc): boolean {
  return d.cols < CANVAS_MAX_COLS;
}

export function canGrowRows(d: CanvasDoc): boolean {
  return d.rows < CANVAS_MAX_ROWS;
}

export function growCols(d: CanvasDoc): boolean {
  if (!canGrowCols(d)) return false;
  d.cols += 1;
  return true;
}

export function growRows(d: CanvasDoc): boolean {
  if (!canGrowRows(d)) return false;
  d.rows += 1;
  return true;
}

// Filled (non-empty) cells in row-major order — the publish set.
export function filledCells(d: CanvasDoc): { x: number; y: number; frames: Bitmap[] }[] {
  const out: { x: number; y: number; frames: Bitmap[] }[] = [];
  for (let y = 0; y < d.rows; y++) {
    for (let x = 0; x < d.cols; x++) {
      const frames = getCell(d, x, y);
      if (frames && !framesEmpty(frames)) out.push({ x, y, frames });
    }
  }
  return out;
}

export function isMultiTile(d: CanvasDoc): boolean {
  return d.cols * d.rows > 1;
}
