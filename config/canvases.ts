export const TILES_PER_SIDE = 16;
export const TILES_PER_CANVAS = TILES_PER_SIDE * TILES_PER_SIDE;

export const CLAIM_TTL_S = 30 * 60;
export const PUBLISH_COOLDOWN_S = 15 * 60;

const CANVAS_ID_RE = /^canvas-(\d{4})-W(\d{2})$/;
const TILE_KEY_RE = /^(\d+),(\d+)$/;

const MS_PER_DAY = 86_400_000;

export function isCanvasIdValid(id: string): boolean {
  return CANVAS_ID_RE.test(id);
}

function isoWeekParts(date: Date): { year: number; week: number } {
  // Shift to Thursday of the same ISO week (Thursday's year owns the week).
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() + 3 - dayNum);
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const firstThursday = new Date(Date.UTC(year, 0, 4 + 3 - jan4Day));
  const week =
    Math.round((d.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY)) + 1;
  return { year, week };
}

export function canvasIdForDate(date: Date): string {
  const { year, week } = isoWeekParts(date);
  return `canvas-${year}-W${String(week).padStart(2, "0")}`;
}

function parseCanvasId(canvasId: string): { year: number; week: number } | null {
  const m = CANVAS_ID_RE.exec(canvasId);
  if (!m) return null;
  return { year: parseInt(m[1], 10), week: parseInt(m[2], 10) };
}

export function canvasOpensAt(canvasId: string): Date {
  const parts = parseCanvasId(canvasId);
  if (!parts) throw new Error(`invalid canvas id: ${canvasId}`);
  const { year, week } = parts;
  // Jan 4 is always in ISO week 1. Walk back to its Monday, then add (week-1) weeks.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4IsoDay = ((jan4.getUTCDay() + 6) % 7) + 1; // 1=Mon..7=Sun
  const mondayWeek1 = new Date(Date.UTC(year, 0, 4 - (jan4IsoDay - 1)));
  return new Date(mondayWeek1.getTime() + (week - 1) * 7 * MS_PER_DAY);
}

export function canvasClosesAt(canvasId: string): Date {
  return new Date(canvasOpensAt(canvasId).getTime() + 7 * MS_PER_DAY);
}

export function canvasName(canvasId: string): string {
  const parts = parseCanvasId(canvasId);
  if (!parts) return canvasId;
  return `Week ${parts.week}, ${parts.year}`;
}

export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseTileKey(key: string): { x: number; y: number } | null {
  const m = TILE_KEY_RE.exec(key);
  if (!m) return null;
  const x = parseInt(m[1], 10);
  const y = parseInt(m[2], 10);
  if (x < 0 || x >= TILES_PER_SIDE) return null;
  if (y < 0 || y >= TILES_PER_SIDE) return null;
  return { x, y };
}

export function isTileKeyValid(key: string): boolean {
  return parseTileKey(key) !== null;
}
