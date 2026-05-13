// Where the user's drawing goes on a tee (or other product). Translates
// directly to Printify's `placeholders[].images[]` array: x and y are
// 0..1 fractions of the placeholder rect (the image's CENTER lands at
// (x, y)), scale is a fraction of the placeholder area (1 = full bleed,
// 0.25 = quarter), angle is rotation in degrees (always 0 here).
//
// Pattern presets repeat the same image in an n×n grid with each cell
// centred and scaled to 1/n so the cells tile cleanly.

export const NAMED_PRESETS = [
  "full-chest",
  "left-chest",
  "right-chest",
  "center-pocket",
] as const;

export const PATTERN_PRESETS = [
  "pattern-2x2",
  "pattern-3x3",
  "pattern-4x4",
  "pattern-5x5",
  "pattern-6x6",
  "pattern-7x7",
  "pattern-8x8",
] as const;

export const PLACEMENT_PRESETS = [...NAMED_PRESETS, ...PATTERN_PRESETS] as const;

export type Placement = (typeof PLACEMENT_PRESETS)[number];

export const DEFAULT_PLACEMENT: Placement = "full-chest";

export function isValidPlacement(v: unknown): v is Placement {
  return typeof v === "string" && (PLACEMENT_PRESETS as readonly string[]).includes(v);
}

export interface PrintifyImageEntry {
  id: string;
  x: number;
  y: number;
  scale: number;
  angle: number;
}

const NAMED: Record<(typeof NAMED_PRESETS)[number], { x: number; y: number; scale: number }> = {
  "full-chest":    { x: 0.5, y: 0.5,  scale: 1 },
  "left-chest":    { x: 0.3, y: 0.25, scale: 0.25 },
  "right-chest":   { x: 0.7, y: 0.25, scale: 0.25 },
  "center-pocket": { x: 0.5, y: 0.3,  scale: 0.25 },
};

export function expandPlacement(placement: Placement, imageId: string): PrintifyImageEntry[] {
  if ((NAMED_PRESETS as readonly string[]).includes(placement)) {
    const cfg = NAMED[placement as (typeof NAMED_PRESETS)[number]];
    return [{ id: imageId, x: cfg.x, y: cfg.y, scale: cfg.scale, angle: 0 }];
  }
  const m = /^pattern-(\d+)x\1$/.exec(placement);
  if (!m) throw new Error(`unknown placement: ${placement}`);
  return patternGrid(imageId, Number(m[1]));
}

export function patternGridSize(placement: Placement): number | null {
  const m = /^pattern-(\d+)x\1$/.exec(placement);
  return m ? Number(m[1]) : null;
}

function patternGrid(imageId: string, n: number): PrintifyImageEntry[] {
  // Bounded to the presets actually exposed in PATTERN_PRESETS. A larger
  // n would produce hundreds of image entries Printify might reject and
  // the user can't reasonably see; clamp here as defence in depth in
  // case bad data lands in a DynamoDB row.
  if (!Number.isInteger(n) || n < 2 || n > 8) {
    throw new Error(`invalid pattern grid size: ${n}`);
  }
  const out: PrintifyImageEntry[] = [];
  const scale = 1 / n;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      out.push({
        id: imageId,
        x: (col + 0.5) / n,
        y: (row + 0.5) / n,
        scale,
        angle: 0,
      });
    }
  }
  return out;
}
