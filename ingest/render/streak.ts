import { CC_PROFILE } from "../../config/constants.js";
import { isAnonymousUsername } from "../../config/constants.js";
import renderStreak, {
  type DayCell,
  type MonthBlock,
  type StreakView,
} from "../../lib/templates/streak.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";
import { isProfileRoutable, notFound, ownerStatsView } from "./shared.js";
import type { DrawingCursor, DrawingRow } from "../drawing-store.js";

const STREAK_SCAN_PAGE_SIZE = 200;

export async function renderStreakPageHandler(
  cfg: RenderHandlersConfig,
  username: string
): Promise<RenderResponse> {
  if (!isProfileRoutable(username)) return notFound(cfg);
  const account =
    cfg.userStore && !isAnonymousUsername(username)
      ? await cfg.userStore.getByUsername(username)
      : null;

  const byDay = new Map<string, DrawingRow>();
  let userId: string | null = account?.user_id ?? null;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  let cursor: DrawingCursor | undefined;
  for (;;) {
    const page = await cfg.drawingStore.queryByUsername(username, {
      limit: STREAK_SCAN_PAGE_SIZE,
      cursor,
    });
    for (const row of page.items) {
      if (!userId) userId = row.user_id;
      if (lastMs === null) lastMs = row.created_at_ms;
      firstMs = row.created_at_ms;
      const dayKey = row.created_at.slice(0, 10);
      byDay.set(dayKey, row);
    }
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }

  if (byDay.size === 0) {
    if (!account) return notFound(cfg);
    return {
      status: 200,
      contentType: "text/html; charset=utf-8",
      cacheControl: CC_PROFILE,
      body: renderStreak({
        username,
        profile_picture_drawing_id: account.profile_picture_drawing_id ?? null,
        daily_streak_current: 0,
        daily_streak_longest: 0,
        total_days_drawn: 0,
        months: [],
        repo_url: cfg.repoUrl,
      }),
    };
  }

  const stats =
    cfg.userStatsStore && userId ? await ownerStatsView(cfg.userStatsStore, userId) : undefined;
  const today = cfg.now ? cfg.now() : new Date();
  const todayKey = isoDayUtc(today);
  const firstKey = isoDayUtc(new Date(firstMs!));
  const months = buildMonthBlocks(firstKey, todayKey, byDay);
  const view: StreakView = {
    username,
    profile_picture_drawing_id: account?.profile_picture_drawing_id ?? null,
    daily_streak_current: stats?.daily_streak_current ?? 0,
    daily_streak_longest: stats?.daily_streak_longest ?? 0,
    total_days_drawn: byDay.size,
    months,
    repo_url: cfg.repoUrl,
  };
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_PROFILE,
    body: renderStreak(view),
  };
}

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function isoDayUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function buildMonthBlocks(
  firstKey: string,
  todayKey: string,
  byDay: Map<string, DrawingRow>
): MonthBlock[] {
  const [firstY, firstM] = parseYearMonth(firstKey);
  const [todayY, todayM] = parseYearMonth(todayKey);
  const months: MonthBlock[] = [];
  let y = todayY;
  let m = todayM;
  while (y > firstY || (y === firstY && m >= firstM)) {
    months.push(buildMonthBlock(y, m, byDay));
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return months;
}

function buildMonthBlock(year: number, month: number, byDay: Map<string, DrawingRow>): MonthBlock {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const leadingPad = (firstWeekday + 6) % 7;
  const cells: DayCell[] = [];
  for (let i = 0; i < leadingPad; i += 1) {
    cells.push({ date: "", day: 0, kind: "out-of-range" });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const row = byDay.get(dateKey);
    const cell: DayCell = {
      date: dateKey,
      day,
      kind: row ? "thumb" : "empty",
    };
    if (row) cell.drawing_id = row.drawing_id;
    cells.push(cell);
  }
  return {
    year,
    month,
    label: `${MONTH_LABELS[month - 1]} ${year}`,
    cells,
  };
}

function parseYearMonth(isoDay: string): [number, number] {
  const y = Number.parseInt(isoDay.slice(0, 4), 10);
  const m = Number.parseInt(isoDay.slice(5, 7), 10);
  return [y, m];
}
