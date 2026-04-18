import { WIDTH, HEIGHT } from "../../config/constants.js";
import { Bitmap, TRANSPARENT } from "./bitmap.js";
import type { RGB } from "./palette.js";

export interface CanvasSettings {
  pixelSize: number;
  showGrid: boolean;
  gridColor: string;
}

export class PixelCanvas {
  private readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly settings: CanvasSettings;

  constructor(el: HTMLCanvasElement, settings: CanvasSettings) {
    this.el = el;
    const ctx = el.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.settings = settings;
    el.width = WIDTH * settings.pixelSize;
    el.height = HEIGHT * settings.pixelSize;
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.el.width, this.el.height);
  }

  quantize(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.el.getBoundingClientRect();
    const px = this.settings.pixelSize * (rect.width / this.el.width);
    const py = this.settings.pixelSize * (rect.height / this.el.height);
    const x = Math.floor((clientX - rect.left) / px);
    const y = Math.floor((clientY - rect.top) / py);
    return {
      x: Math.max(0, Math.min(WIDTH - 1, x)),
      y: Math.max(0, Math.min(HEIGHT - 1, y)),
    };
  }

  draw(bitmap: Bitmap, palette: readonly RGB[]): void {
    this.clear();
    const ps = this.settings.pixelSize;
    for (let y = 0; y < bitmap.height; y++) {
      for (let x = 0; x < bitmap.width; x++) {
        const v = bitmap.get(x, y);
        if (v === TRANSPARENT) continue;
        const [r, g, b] = palette[v];
        this.ctx.fillStyle = `rgb(${r},${g},${b})`;
        this.ctx.fillRect(x * ps, y * ps, ps, ps);
      }
    }
    if (this.settings.showGrid) this.drawGrid();
  }

  private drawGrid(): void {
    this.ctx.strokeStyle = this.settings.gridColor;
    this.ctx.lineWidth = 1;
    const ps = this.settings.pixelSize;
    const total = WIDTH * ps;
    this.ctx.beginPath();
    for (let i = 1; i < WIDTH; i++) {
      this.ctx.moveTo(i * ps + 0.5, 0);
      this.ctx.lineTo(i * ps + 0.5, total);
      this.ctx.moveTo(0, i * ps + 0.5);
      this.ctx.lineTo(total, i * ps + 0.5);
    }
    this.ctx.stroke();
  }
}
