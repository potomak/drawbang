// Badge thresholds for #115/#116. Badges are derived from the per-pubkey
// counters in UserStatsRow (no separate storage) — earnedBadges() takes a
// stats row and returns the subset of definitions whose threshold the user
// has crossed.
//
// Two dimensions:
//   - daily: threshold compares against UserStatsRow.daily_total (total
//     distinct drawings published, gated by content-addressed gif novelty
//     upstream so re-publishes don't double-count).
//   - mural: threshold compares against UserStatsRow.mural_total (number
//     of distinct weekly murals the user has placed at least one tile in).

export type BadgeDimension = "daily" | "mural";

export interface BadgeDef {
  id: string;
  dimension: BadgeDimension;
  threshold: number;
  label: string;
}

export const DAILY_DRAWING_BADGES: readonly BadgeDef[] = [
  { id: "daily-7",   dimension: "daily", threshold: 7,   label: "1 week of drawings" },
  { id: "daily-30",  dimension: "daily", threshold: 30,  label: "1 month of drawings" },
  { id: "daily-90",  dimension: "daily", threshold: 90,  label: "3 months of drawings" },
  { id: "daily-180", dimension: "daily", threshold: 180, label: "6 months of drawings" },
  { id: "daily-365", dimension: "daily", threshold: 365, label: "1 year of drawings" },
];

export const MURAL_BADGES: readonly BadgeDef[] = [
  { id: "mural-10", dimension: "mural", threshold: 10, label: "10 murals" },
  { id: "mural-26", dimension: "mural", threshold: 26, label: "Half a year of murals" },
  { id: "mural-52", dimension: "mural", threshold: 52, label: "1 year of murals" },
];

export const ALL_BADGES: readonly BadgeDef[] = [
  ...DAILY_DRAWING_BADGES,
  ...MURAL_BADGES,
];

export interface BadgeCounts {
  daily_total: number;
  mural_total: number;
}

export function earnedBadges(stats: BadgeCounts): {
  daily: BadgeDef[];
  mural: BadgeDef[];
} {
  return {
    daily: DAILY_DRAWING_BADGES.filter((b) => stats.daily_total >= b.threshold),
    mural: MURAL_BADGES.filter((b) => stats.mural_total >= b.threshold),
  };
}
