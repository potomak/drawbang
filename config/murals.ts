export const TILES_PER_SIDE = 16;
export const TILES_PER_MURAL = TILES_PER_SIDE * TILES_PER_SIDE;

export const CLAIM_TTL_S = 30 * 60;
export const PUBLISH_COOLDOWN_S = 15 * 60;

const MURAL_ID_RE = /^mural-(\d{4})-W(\d{2})$/;
const TILE_KEY_RE = /^(\d+),(\d+)$/;

const MS_PER_DAY = 86_400_000;

export function isMuralIdValid(id: string): boolean {
  return MURAL_ID_RE.test(id);
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

export function muralIdForDate(date: Date): string {
  const { year, week } = isoWeekParts(date);
  return `mural-${year}-W${String(week).padStart(2, "0")}`;
}

function parseMuralId(muralId: string): { year: number; week: number } | null {
  const m = MURAL_ID_RE.exec(muralId);
  if (!m) return null;
  return { year: parseInt(m[1], 10), week: parseInt(m[2], 10) };
}

export function muralOpensAt(muralId: string): Date {
  const parts = parseMuralId(muralId);
  if (!parts) throw new Error(`invalid mural id: ${muralId}`);
  const { year, week } = parts;
  // Jan 4 is always in ISO week 1. Walk back to its Monday, then add (week-1) weeks.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4IsoDay = ((jan4.getUTCDay() + 6) % 7) + 1; // 1=Mon..7=Sun
  const mondayWeek1 = new Date(Date.UTC(year, 0, 4 - (jan4IsoDay - 1)));
  return new Date(mondayWeek1.getTime() + (week - 1) * 7 * MS_PER_DAY);
}

export function muralClosesAt(muralId: string): Date {
  return new Date(muralOpensAt(muralId).getTime() + 7 * MS_PER_DAY);
}

export function muralName(muralId: string): string {
  const parts = parseMuralId(muralId);
  if (!parts) return muralId;
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
