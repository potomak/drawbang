import { DEFAULT_SIZE } from "../../config/constants.js";
import { Bitmap, TRANSPARENT } from "./bitmap.js";
import type { RGB } from "./palette.js";

export interface CanvasSettings {
  pixelSize: number;
  showGrid: boolean;
  gridColor: string;
  // Drawing-grid dimension (in pixels). Defaults to DEFAULT_SIZE; the editor
  // changes this at runtime when the user picks a different canvas size.
  size?: number;
  // When true, draw a faint dashed vertical line at the canvas's
  // horizontal mirror axis (width/2). Set by the editor when horizontal
  // symmetry mode is on so the user sees where the mirror runs.
  symmetryAxisH?: boolean;
}

export class PixelCanvas {
  private readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly settings: CanvasSettings;
  private size: number;

  constructor(el: HTMLCanvasElement, settings: CanvasSettings) {
    this.el = el;
    const ctx = el.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.settings = settings;
    this.size = settings.size ?? DEFAULT_SIZE;
    el.width = this.size * settings.pixelSize;
    el.height = this.size * settings.pixelSize;
  }

  // Reconfigure for a new drawing-grid dimension. `pixelSize` is provided
  // explicitly so callers can choose the right zoom for the new size.
  setSize(newSize: number, pixelSize: number): void {
    this.size = newSize;
    this.settings.pixelSize = pixelSize;
    this.el.width = newSize * pixelSize;
    this.el.height = newSize * pixelSize;
    this.clear();
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.el.width, this.el.height);
  }

  quantize(clientX: number, clientY: number): { x: number; y: number } {
    const { x, y } = this.quantizeUnclamped(clientX, clientY);
    return {
      x: Math.max(0, Math.min(this.size - 1, x)),
      y: Math.max(0, Math.min(this.size - 1, y)),
    };
  }

  // Same math as `quantize` minus the bounds clamp. The Move tool needs
  // unbounded deltas so a drag that runs past the canvas edge keeps
  // accumulating translation instead of stalling at the boundary cell.
  quantizeUnclamped(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect();
    const px = this.settings.pixelSize * (rect.width / this.el.width);
    const py = this.settings.pixelSize * (rect.height / this.el.height);
    return {
      x: Math.floor((clientX - rect.left) / px),
      y: Math.floor((clientY - rect.top) / py),
    };
  }

  draw(bitmap: Bitmap, palette: readonly RGB[], onion?: Bitmap | null): void {
    const ps = this.settings.pixelSize;
    // Size the backing canvas to the bitmap. The editor always draws a
    // size×size cell (no-op resize on the common path), but the merch
    // preview reuses this to render an upscaled cell — without resizing,
    // anything past the fixed buffer was clipped.
    const w = bitmap.width * ps;
    const h = bitmap.height * ps;
    if (this.el.width !== w || this.el.height !== h) {
      this.el.width = w;
      this.el.height = h;
    }
    this.clear();
    const showMarkers = this.settings.showGrid;
    const dot = Math.max(1, Math.floor(ps / 6));
    const dotOffset = Math.floor((ps - dot) / 2);

    // Onion underlay: previous frame's colored pixels at 22% opacity behind
    // the current frame. Skipped for transparent cells so the underlay never
    // bleeds into the dot pattern that signals transparency.
    if (onion) {
      this.ctx.globalAlpha = 0.22;
      for (let y = 0; y < onion.height; y++) {
        for (let x = 0; x < onion.width; x++) {
          const v = onion.get(x, y);
          if (v === TRANSPARENT) continue;
          const [r, g, b] = palette[v];
          this.ctx.fillStyle = `rgb(${r},${g},${b})`;
          this.ctx.fillRect(x * ps, y * ps, ps, ps);
        }
      }
      this.ctx.globalAlpha = 1;
    }

    for (let y = 0; y < bitmap.height; y++) {
      for (let x = 0; x < bitmap.width; x++) {
        const v = bitmap.get(x, y);
        if (v === TRANSPARENT) {
          if (!showMarkers) continue;
          // When onion is on, skip the transparent-cell tint so the
          // faded underlay stays visible; keep the small grid dot.
          // Colours track the light --canvas-bg: a slightly-darker
          // tint of paper-2 for the cell, and a visible-but-soft dot
          // on top.
          if (!onion) {
            this.ctx.fillStyle = "#ededeb";
            this.ctx.fillRect(x * ps, y * ps, ps, ps);
          }
          this.ctx.fillStyle = "#b8b3a8";
          this.ctx.fillRect(x * ps + dotOffset, y * ps + dotOffset, dot, dot);
        } else {
          const [r, g, b] = palette[v];
          this.ctx.fillStyle = `rgb(${r},${g},${b})`;
          this.ctx.fillRect(x * ps, y * ps, ps, ps);
        }
      }
    }
    if (this.settings.showGrid) this.drawGrid(bitmap);
    if (this.settings.symmetryAxisH && bitmap.width % 2 === 0) {
      this.drawSymmetryAxisH(bitmap);
    }
  }

  // Soft dashed line down the canvas's vertical mirror axis. Reuses
  // gridColor so the overlay reads as a guide rather than as art.
  private drawSymmetryAxisH(bitmap: Bitmap): void {
    const ps = this.settings.pixelSize;
    const axisX = (bitmap.width / 2) * ps + 0.5;
    this.ctx.save();
    this.ctx.strokeStyle = this.settings.gridColor;
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([Math.max(2, ps / 2), Math.max(2, ps / 2)]);
    this.ctx.beginPath();
    this.ctx.moveTo(axisX, 0);
    this.ctx.lineTo(axisX, bitmap.height * ps);
    this.ctx.stroke();
    this.ctx.restore();
  }

  // Grid lines only run along edges where both adjacent cells are
  // transparent. A line through (or next to) a colored pixel would chop
  // up the pixel art the user is making — the grid is a guide for the
  // empty canvas, not a permanent overlay.
  private drawGrid(bitmap: Bitmap): void {
    this.ctx.strokeStyle = this.settings.gridColor;
    this.ctx.lineWidth = 1;
    const ps = this.settings.pixelSize;
    this.ctx.beginPath();
    // Vertical edges between columns x and x+1.
    for (let x = 0; x < bitmap.width - 1; x++) {
      for (let y = 0; y < bitmap.height; y++) {
        if (bitmap.get(x, y) !== TRANSPARENT) continue;
        if (bitmap.get(x + 1, y) !== TRANSPARENT) continue;
        const lineX = (x + 1) * ps + 0.5;
        this.ctx.moveTo(lineX, y * ps);
        this.ctx.lineTo(lineX, (y + 1) * ps);
      }
    }
    // Horizontal edges between rows y and y+1.
    for (let y = 0; y < bitmap.height - 1; y++) {
      for (let x = 0; x < bitmap.width; x++) {
        if (bitmap.get(x, y) !== TRANSPARENT) continue;
        if (bitmap.get(x, y + 1) !== TRANSPARENT) continue;
        const lineY = (y + 1) * ps + 0.5;
        this.ctx.moveTo(x * ps, lineY);
        this.ctx.lineTo((x + 1) * ps, lineY);
      }
    }
    this.ctx.stroke();
  }
}
