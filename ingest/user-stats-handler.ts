import { earnedBadges, type BadgeDef } from "../config/badges.js";
import type { UserStatsStore } from "./user-stats-store.js";

// GET /users/{user_id}/stats — returns the per-account streak/total counters
// (#115/#116) plus the badge subset earned at the current totals. Lets the
// profile page hydrate fresh values on every visit instead of waiting for the
// next builder run. Server-rendered values in /u/<username>.html stay as
// the offline fallback.

export interface UserStatsResponseBody {
  user_id: string;
  daily_total: number;
  daily_streak_current: number;
  daily_streak_longest: number;
  daily_last_date: string | null;
  canvas_total: number;
  canvas_streak_current: number;
  canvas_streak_longest: number;
  canvas_last_id: string | null;
  daily_badges: BadgeDef[];
  canvas_badges: BadgeDef[];
}

export interface UserStatsHandlerConfig {
  userStatsStore: UserStatsStore;
}

export interface UserStatsHandlerResult {
  status: 200 | 400;
  body: UserStatsResponseBody | { error: string };
  headers: Record<string, string>;
}

export async function handleUserStats(
  user_id: string,
  cfg: UserStatsHandlerConfig,
): Promise<UserStatsHandlerResult> {
  if (!/^[0-9a-f]{64}$/.test(user_id)) {
    return {
      status: 400,
      body: { error: "invalid user_id" },
      headers: { "Content-Type": "application/json" },
    };
  }
  const row = await cfg.userStatsStore.get(user_id);
  const totals = {
    daily_total: row?.daily_total ?? 0,
    canvas_total: row?.canvas_total ?? 0,
  };
  const badges = earnedBadges(totals);
  return {
    status: 200,
    body: {
      user_id,
      daily_total: totals.daily_total,
      daily_streak_current: row?.daily_streak_current ?? 0,
      daily_streak_longest: row?.daily_streak_longest ?? 0,
      daily_last_date: row?.daily_last_date ?? null,
      canvas_total: totals.canvas_total,
      canvas_streak_current: row?.canvas_streak_current ?? 0,
      canvas_streak_longest: row?.canvas_streak_longest ?? 0,
      canvas_last_id: row?.canvas_last_id ?? null,
      daily_badges: badges.daily,
      canvas_badges: badges.canvas,
    },
    headers: {
      "Content-Type": "application/json",
      // Short cache so a quick reload picks up the user's latest publish;
      // not no-store because two visits within ~15s shouldn't both pay for
      // a DDB Get on a decorative read.
      "Cache-Control": "public, max-age=15",
    },
  };
}
