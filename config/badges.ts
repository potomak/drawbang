// Badge thresholds for #115/#116. Badges are derived from the per-pubkey
// counters in UserStatsRow (no separate storage) — earnedBadges() takes a
// stats row and returns the subset of definitions whose threshold the user
// has crossed.
//
// Single dimension:
//   - daily: threshold compares against UserStatsRow.daily_total (total
//     distinct drawings published, gated by content-addressed gif novelty
//     upstream so re-publishes don't double-count).

export type BadgeDimension = "daily";

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

export const ALL_BADGES: readonly BadgeDef[] = [...DAILY_DRAWING_BADGES];

export interface BadgeCounts {
  daily_total: number;
}

export function earnedBadges(stats: BadgeCounts): {
  daily: BadgeDef[];
} {
  return {
    daily: DAILY_DRAWING_BADGES.filter((b) => stats.daily_total >= b.threshold),
  };
}
