import { ACTIVE_PALETTE_SIZE, BASE_PALETTE_SIZE } from "../../config/constants.js";

export type RGB = readonly [number, number, number];

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

// 256-color base palette: a perceptually-spaced grid that covers the full
// RGB cube. Layout: 6x8x5 (r*g*b) = 240 color cube + 16 grayscale.
// Every user sees exactly the same set; base-palette indices (0..255) are
// what the editor persists inside the GIF's DRAWBANG application extension.
function buildBasePalette(): RGB[] {
  const palette: RGB[] = [];
  const rSteps = [0, 51, 102, 153, 204, 255];
  const gSteps = [0, 36, 73, 109, 146, 182, 219, 255];
  const bSteps = [0, 64, 128, 191, 255];
  for (const r of rSteps) {
    for (const g of gSteps) {
      for (const b of bSteps) {
        palette.push([r, g, b]);
      }
    }
  }
  for (let i = 0; i < 16; i++) {
    const v = Math.round((i * 255) / 15);
    palette.push([v, v, v]);
  }
  if (palette.length !== BASE_PALETTE_SIZE) {
    throw new Error(`base palette size mismatch: ${palette.length}`);
  }
  return palette;
}

export const BASE_PALETTE: readonly RGB[] = buildBasePalette();

// EGA palette, matching legacy/config/config.rb. Each hex maps to the nearest
// base-palette index — giving us a default 16-slot active selection that
// looks exactly like the old editor.
const EGA_HEX = [
  "#000000", "#555555", "#0000aa", "#5555ff",
  "#00aa00", "#55ff55", "#00aaaa", "#55ffff",
  "#aa0000", "#ff5555", "#aa00aa", "#ff55ff",
  "#aa5500", "#ffff55", "#aaaaaa", "#ffffff",
] as const;

function nearestBaseIndex(rgb: RGB): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < BASE_PALETTE.length; i++) {
    const [r, g, b] = BASE_PALETTE[i];
    const dr = r - rgb[0], dg = g - rgb[1], db = b - rgb[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
      if (d === 0) break;
    }
  }
  return best;
}

export const DEFAULT_ACTIVE_PALETTE: Uint8Array = (() => {
  const out = new Uint8Array(ACTIVE_PALETTE_SIZE);
  for (let i = 0; i < ACTIVE_PALETTE_SIZE; i++) {
    out[i] = nearestBaseIndex(hexToRgb(EGA_HEX[i]));
  }
  return out;
})();

export function activePaletteToRgb(active: Uint8Array): RGB[] {
  if (active.length !== ACTIVE_PALETTE_SIZE) {
    throw new Error(`active palette must be ${ACTIVE_PALETTE_SIZE} bytes`);
  }
  return Array.from(active, (idx) => BASE_PALETTE[idx]);
}

export function activePaletteToHex(active: Uint8Array): string[] {
  return activePaletteToRgb(active).map(rgbToHex);
}

export { hexToRgb, rgbToHex, nearestBaseIndex };
