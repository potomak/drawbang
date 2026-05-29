import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

// Per-user_id aggregated stats for streaks + badges (#115, #116).
//
// One row per user_id. One dimension: daily drawings (any publish that lands
// a new gif under inbox/). Carries a running total (drives badges) and a
// streak (drives the "consecutive days" UX).
//
// Streak math is read-modify-write — the "yesterday vs other" branch can't
// be expressed as a single UpdateExpression. The Dynamo impl uses an
// optimistic-concurrency loop conditioned on the prior daily_last_date so
// concurrent publishes converge correctly.
//
// Idempotency lives at the call site: handleIngest only hooks the daily
// counter when !alreadyHere (so re-publishes of an existing gif don't
// double-count).

export interface UserStatsRow {
  user_id: string;
  daily_total: number;
  daily_streak_current: number;
  daily_streak_longest: number;
  daily_last_date: string | null;
  updated_at: string;
}

export interface RecordDailyDrawingArgs {
  user_id: string;
  // ISO YYYY-MM-DD (UTC). Caller derives this from nowISO.slice(0, 10).
  date_utc: string;
  now_iso: string;
}

export interface UserStatsStore {
  // Bumps daily_total + advances streak for a new drawing published on
  // date_utc. Same-day re-publishes only bump the total (consecutive-day
  // logic doesn't re-fire). Caller MUST gate by gif-novelty (!alreadyHere)
  // so re-publishes of an existing gif don't reach this method.
  recordDailyDrawing(args: RecordDailyDrawingArgs): Promise<UserStatsRow>;
  get(user_id: string): Promise<UserStatsRow | null>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function previousDayUtc(dateUtc: string): string {
  if (!DATE_RE.test(dateUtc)) throw new Error(`invalid date_utc: ${dateUtc}`);
  const [y, m, d] = dateUtc.split("-").map((p) => parseInt(p, 10));
  const t = Date.UTC(y, m - 1, d) - 86_400_000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function zeroRow(user_id: string, nowIso: string): UserStatsRow {
  return {
    user_id,
    daily_total: 0,
    daily_streak_current: 0,
    daily_streak_longest: 0,
    daily_last_date: null,
    updated_at: nowIso,
  };
}

interface NextDailyState {
  daily_total: number;
  daily_streak_current: number;
  daily_streak_longest: number;
  daily_last_date: string;
}

function nextDailyState(prior: UserStatsRow | null, dateUtc: string): NextDailyState {
  const base = prior ?? zeroRow("", "");
  if (base.daily_last_date === dateUtc) {
    return {
      daily_total: base.daily_total + 1,
      daily_streak_current: base.daily_streak_current,
      daily_streak_longest: base.daily_streak_longest,
      daily_last_date: dateUtc,
    };
  }
  const yesterday = previousDayUtc(dateUtc);
  const continued = base.daily_last_date === yesterday;
  const newStreak = continued ? base.daily_streak_current + 1 : 1;
  return {
    daily_total: base.daily_total + 1,
    daily_streak_current: newStreak,
    daily_streak_longest: Math.max(base.daily_streak_longest, newStreak),
    daily_last_date: dateUtc,
  };
}

// -- DynamoDB -----------------------------------------------------------------

export interface DynamoUserStatsStoreOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
  maxRetries?: number;
}

export class DynamoUserStatsStore implements UserStatsStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;
  private readonly maxRetries: number;

  constructor(opts: DynamoUserStatsStoreOptions) {
    this.table = opts.tableName;
    this.maxRetries = opts.maxRetries ?? 5;
    this.doc =
      opts.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async get(user_id: string): Promise<UserStatsRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { user_id } }),
    );
    if (!r.Item) return null;
    return this.normalize(r.Item, user_id);
  }

  async recordDailyDrawing(args: RecordDailyDrawingArgs): Promise<UserStatsRow> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const prior = await this.get(args.user_id);
      const next = nextDailyState(prior, args.date_utc);
      try {
        const r = await this.doc.send(this.dailyUpdate(args, prior, next));
        return this.normalize(r.Attributes ?? {}, args.user_id);
      } catch (e) {
        if (!isConditionalCheckFailed(e)) throw e;
      }
    }
    throw new Error(
      `recordDailyDrawing: optimistic-concurrency retries exhausted for ${args.user_id}`,
    );
  }

  private dailyUpdate(
    args: RecordDailyDrawingArgs,
    prior: UserStatsRow | null,
    next: NextDailyState,
  ): UpdateCommand {
    const expr =
      "SET daily_total = :dt, daily_streak_current = :dsc, daily_streak_longest = :dsl, daily_last_date = :dld, updated_at = :now";
    const values: Record<string, unknown> = {
      ":dt": next.daily_total,
      ":dsc": next.daily_streak_current,
      ":dsl": next.daily_streak_longest,
      ":dld": next.daily_last_date,
      ":now": args.now_iso,
    };
    const condition = prior
      ? "daily_total = :prior_dt AND daily_last_date = :prior_dld"
      : "attribute_not_exists(user_id)";
    if (prior) {
      values[":prior_dt"] = prior.daily_total;
      if (prior.daily_last_date === null) {
        values[":prior_dt_only"] = prior.daily_total;
        return new UpdateCommand({
          TableName: this.table,
          Key: { user_id: args.user_id },
          UpdateExpression: expr,
          ConditionExpression: "daily_total = :prior_dt_only AND attribute_not_exists(daily_last_date)",
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        });
      }
      values[":prior_dld"] = prior.daily_last_date;
    }
    return new UpdateCommand({
      TableName: this.table,
      Key: { user_id: args.user_id },
      UpdateExpression: expr,
      ConditionExpression: condition,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    });
  }

  private normalize(item: Record<string, unknown>, user_id: string): UserStatsRow {
    return {
      user_id: (item.user_id as string) ?? user_id,
      daily_total: (item.daily_total as number) ?? 0,
      daily_streak_current: (item.daily_streak_current as number) ?? 0,
      daily_streak_longest: (item.daily_streak_longest as number) ?? 0,
      daily_last_date: (item.daily_last_date as string) ?? null,
      updated_at: (item.updated_at as string) ?? "",
    };
  }
}

function isConditionalCheckFailed(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const name = (e as { name?: unknown }).name;
  return name === "ConditionalCheckFailedException";
}

// -- In-memory (tests + dev) --------------------------------------------------

export class MemoryUserStatsStore implements UserStatsStore {
  private readonly rows = new Map<string, UserStatsRow>();

  async get(user_id: string): Promise<UserStatsRow | null> {
    return this.rows.get(user_id) ?? null;
  }

  async recordDailyDrawing(args: RecordDailyDrawingArgs): Promise<UserStatsRow> {
    const prior = this.rows.get(args.user_id) ?? null;
    const next = nextDailyState(prior, args.date_utc);
    const merged: UserStatsRow = {
      ...(prior ?? zeroRow(args.user_id, args.now_iso)),
      user_id: args.user_id,
      daily_total: next.daily_total,
      daily_streak_current: next.daily_streak_current,
      daily_streak_longest: next.daily_streak_longest,
      daily_last_date: next.daily_last_date,
      updated_at: args.now_iso,
    };
    this.rows.set(args.user_id, merged);
    return merged;
  }
}

export { previousDayUtc, nextDailyState };
