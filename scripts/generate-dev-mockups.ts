import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import mockups from "../config/mockups.json" with { type: "json" };

// Generates clearly-labeled dev placeholder mockup PNGs into
// static/mockups/. Each PNG is a flat-colored panel (loosely product-tinted)
// with the print-area rectangle indicated. These are *not* real Printify
// mockups — they exist so /merch?d=<id> renders something useful while we
// wait on the Printify-fetch script (#follow-up).
//
// Operator: replace these with real Printify mockup PNGs by running the
// (forthcoming) Printify-fetch script and committing the result. The
// compositor in src/merch-preview.ts reads mockup_url + placeholder from
// config/mockups.json, so as long as the new files keep the same names and
// the JSON's placeholder rectangle stays accurate, no client code needs to
// change.

interface MockupCfg {
  mockup_url: string;
  mockup_width: number;
  mockup_height: number;
  placeholder: { x: number; y: number; width: number; height: number };
}

interface Style {
  bg: [number, number, number];
  fg: [number, number, number];
  label: string;
}

const STYLES: Record<string, Style> = {
  tee:           { bg: [40, 44, 52],   fg: [110, 120, 135], label: "TEE (dev placeholder)" },
  mug:           { bg: [220, 220, 224], fg: [110, 120, 135], label: "MUG (dev placeholder)" },
  "sticker-sheet": { bg: [248, 240, 220], fg: [110, 120, 135], label: "STICKER SHEET (dev placeholder)" },
};

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(PROJECT_ROOT, "static/mockups");

function setPx(png: PNG, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (y * png.width + x) * 4;
  png.data[i] = r;
  png.data[i + 1] = g;
  png.data[i + 2] = b;
  png.data[i + 3] = a;
}

function fillRect(png: PNG, x: number, y: number, w: number, h: number, c: [number, number, number]): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      setPx(png, x + dx, y + dy, c[0], c[1], c[2]);
    }
  }
}

function dashedBorder(png: PNG, x: number, y: number, w: number, h: number, c: [number, number, number]): void {
  const thickness = 3;
  const dash = 12;
  const gap = 8;

  // Top + bottom edges.
  for (let dx = 0; dx < w; dx++) {
    if (Math.floor(dx / (dash + gap)) * (dash + gap) + dash <= dx) continue;
    for (let t = 0; t < thickness; t++) {
      setPx(png, x + dx, y + t, c[0], c[1], c[2]);
      setPx(png, x + dx, y + h - 1 - t, c[0], c[1], c[2]);
    }
  }
  // Left + right edges.
  for (let dy = 0; dy < h; dy++) {
    if (Math.floor(dy / (dash + gap)) * (dash + gap) + dash <= dy) continue;
    for (let t = 0; t < thickness; t++) {
      setPx(png, x + t, y + dy, c[0], c[1], c[2]);
      setPx(png, x + w - 1 - t, y + dy, c[0], c[1], c[2]);
    }
  }
}

// Tiny 5x7 bitmap font for the "(dev placeholder)" label. Each character is
// 5px wide, 7px tall; rows go top->bottom, bits go left->right (MSB = leftmost).
const FONT5x7: Record<string, number[]> = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  "A": [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  "B": [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  "C": [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  "D": [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  "E": [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  "G": [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  "H": [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  "I": [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "K": [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  "L": [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  "M": [0b10001, 0b11011, 0b10101, 0b10001, 0b10001, 0b10001, 0b10001],
  "N": [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  "O": [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  "P": [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  "R": [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  "S": [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  "T": [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  "U": [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  "V": [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  "(": [0b00010, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00010],
  ")": [0b01000, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01000],
};

function drawText(
  png: PNG,
  text: string,
  x: number,
  y: number,
  scale: number,
  c: [number, number, number],
): void {
  const upper = text.toUpperCase();
  let cursorX = x;
  for (const ch of upper) {
    const glyph = FONT5x7[ch] ?? FONT5x7[" "];
    for (let row = 0; row < 7; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if (((bits >> (4 - col)) & 1) === 0) continue;
        fillRect(png, cursorX + col * scale, y + row * scale, scale, scale, c);
      }
    }
    cursorX += 6 * scale; // 5-wide glyph + 1 col gap
  }
}

async function generate(productId: string, cfg: MockupCfg): Promise<void> {
  const style = STYLES[productId];
  if (!style) throw new Error(`no style defined for product ${productId}`);

  const png = new PNG({ width: cfg.mockup_width, height: cfg.mockup_height });
  fillRect(png, 0, 0, png.width, png.height, style.bg);
  // The print area is shaded slightly so it's distinguishable from the bg
  // even before the drawing is composited over it.
  const tint: [number, number, number] = [
    Math.round(style.bg[0] * 0.5 + style.fg[0] * 0.5),
    Math.round(style.bg[1] * 0.5 + style.fg[1] * 0.5),
    Math.round(style.bg[2] * 0.5 + style.fg[2] * 0.5),
  ];
  fillRect(png, cfg.placeholder.x, cfg.placeholder.y, cfg.placeholder.width, cfg.placeholder.height, tint);
  dashedBorder(png, cfg.placeholder.x, cfg.placeholder.y, cfg.placeholder.width, cfg.placeholder.height, style.fg);

  // Label below the placeholder. Scale 4 → 20px tall glyphs.
  const labelScale = 4;
  const labelY = cfg.placeholder.y + cfg.placeholder.height + 24;
  if (labelY + 7 * labelScale < png.height) {
    drawText(png, style.label, cfg.placeholder.x, labelY, labelScale, style.fg);
  }

  const filename = path.basename(cfg.mockup_url);
  const out = path.join(OUT_DIR, filename);
  await new Promise<void>((resolve, reject) => {
    const stream = png.pack();
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => {
      fs.writeFile(out, Buffer.concat(chunks)).then(() => resolve()).catch(reject);
    });
    stream.on("error", reject);
  });
  console.log(`wrote ${out} (${png.width}x${png.height})`);
}

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const products = (mockups as { products: Record<string, MockupCfg> }).products;
  for (const [id, cfg] of Object.entries(products)) {
    await generate(id, cfg);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
