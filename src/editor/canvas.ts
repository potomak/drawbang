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

  draw(bitmap: Bitmap, palette: readonly RGB[], onion?: Bitmap | null): void {
    this.clear();
    const ps = this.settings.pixelSize;
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
          // When onion is on, skip the dark transparent-cell fill so the
          // faded underlay stays visible; keep the small grid dot.
          if (!onion) {
            this.ctx.fillStyle = "#161616";
            this.ctx.fillRect(x * ps, y * ps, ps, ps);
          }
          this.ctx.fillStyle = "#3a3a3a";
          this.ctx.fillRect(x * ps + dotOffset, y * ps + dotOffset, dot, dot);
        } else {
          const [r, g, b] = palette[v];
          this.ctx.fillStyle = `rgb(${r},${g},${b})`;
          this.ctx.fillRect(x * ps, y * ps, ps, ps);
        }
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
