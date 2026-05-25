import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  muralClosesAt,
  muralOpensAt,
  isMuralIdValid,
} from "../config/murals.js";

// Per-user_id aggregated stats for streaks + badges (#115, #116).
//
// One row per user_id. Two dimensions: daily drawings (any publish that lands
// a new gif under inbox/) and weekly mural participation (any publish that
// places a tile via mural_claim). Each dimension carries a running total
// (drives badges) and a streak (drives the "consecutive days/weeks" UX).
//
// Streak math is read-modify-write — the "yesterday vs other" branch can't
// be expressed as a single UpdateExpression. The Dynamo impl uses an
// optimistic-concurrency loop conditioned on the prior daily_last_date /
// mural_last_id so concurrent publishes converge correctly.
//
// Idempotency lives at the call site: handleIngest only hooks the daily
// counter when !alreadyHere (so re-publishes of an existing gif don't
// double-count), and the mural counter sees same-mural re-publishes as
// no-ops here in the store (mural_last_id === mural_id short-circuit).

export interface UserStatsRow {
  user_id: string;
  daily_total: number;
  daily_streak_current: number;
  daily_streak_longest: number;
  daily_last_date: string | null;
  mural_total: number;
  mural_streak_current: number;
  mural_streak_longest: number;
  mural_last_id: string | null;
  updated_at: string;
}

export interface RecordDailyDrawingArgs {
  user_id: string;
  // ISO YYYY-MM-DD (UTC). Caller derives this from nowISO.slice(0, 10).
  date_utc: string;
  now_iso: string;
}

export interface RecordMuralParticipationArgs {
  user_id: string;
  mural_id: string;
  now_iso: string;
}

export interface UserStatsStore {
  // Bumps daily_total + advances streak for a new drawing published on
  // date_utc. Same-day re-publishes only bump the total (consecutive-day
  // logic doesn't re-fire). Caller MUST gate by gif-novelty (!alreadyHere)
  // so re-publishes of an existing gif don't reach this method.
  recordDailyDrawing(args: RecordDailyDrawingArgs): Promise<UserStatsRow>;
  // Bumps mural_total + advances streak the first time user_id publishes
  // into mural_id. Additional tiles into the same mural are no-ops at
  // this layer.
  recordMuralParticipation(args: RecordMuralParticipationArgs): Promise<UserStatsRow>;
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

// True when `prev` is the mural that ended exactly when `next` opens. ISO
// week math lives in config/murals — we just compare boundary timestamps.
function isImmediatelyConsecutiveMural(prev: string, next: string): boolean {
  if (!isMuralIdValid(prev) || !isMuralIdValid(next)) return false;
  return muralClosesAt(prev).getTime() === muralOpensAt(next).getTime();
}

function zeroRow(user_id: string, nowIso: string): UserStatsRow {
  return {
    user_id,
    daily_total: 0,
    daily_streak_current: 0,
    daily_streak_longest: 0,
    daily_last_date: null,
    mural_total: 0,
    mural_streak_current: 0,
    mural_streak_longest: 0,
    mural_last_id: null,
    updated_at: nowIso,
  };
}

interface NextDailyState {
  // Returned shape after applying a daily record to `prior`. `noOp` true means
  // same-day re-publish at the streak layer (total still bumps in caller).
  daily_total: number;
  daily_streak_current: number;
  daily_streak_longest: number;
  daily_last_date: string;
}

function nextDailyState(prior: UserStatsRow | null, dateUtc: string): NextDailyState {
  const base = prior ?? zeroRow("", "");
  if (base.daily_last_date === dateUtc) {
    // Same day: total bumps, streak/last_date stay.
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

interface NextMuralState {
  mural_total: number;
  mural_streak_current: number;
  mural_streak_longest: number;
  mural_last_id: string;
  noOp: boolean; // true when mural_id matches mural_last_id
}

function nextMuralState(prior: UserStatsRow | null, muralId: string): NextMuralState {
  const base = prior ?? zeroRow("", "");
  if (base.mural_last_id === muralId) {
    return {
      mural_total: base.mural_total,
      mural_streak_current: base.mural_streak_current,
      mural_streak_longest: base.mural_streak_longest,
      mural_last_id: muralId,
      noOp: true,
    };
  }
  const consecutive =
    base.mural_last_id !== null &&
    isImmediatelyConsecutiveMural(base.mural_last_id, muralId);
  const newStreak = consecutive ? base.mural_streak_current + 1 : 1;
  return {
    mural_total: base.mural_total + 1,
    mural_streak_current: newStreak,
    mural_streak_longest: Math.max(base.mural_streak_longest, newStreak),
    mural_last_id: muralId,
    noOp: false,
  };
}

// -- DynamoDB -----------------------------------------------------------------

export interface DynamoUserStatsStoreOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
  // Max retries on optimistic-concurrency conflict before throwing. Defaults
  // to 5 — concurrent publishes by the same user_id are rare in practice (the
  // mural branch is already cooldown-gated), so 5 is generous.
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

  async recordMuralParticipation(
    args: RecordMuralParticipationArgs,
  ): Promise<UserStatsRow> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const prior = await this.get(args.user_id);
      const next = nextMuralState(prior, args.mural_id);
      if (next.noOp) return prior ?? zeroRow(args.user_id, args.now_iso);
      try {
        const r = await this.doc.send(this.muralUpdate(args, prior, next));
        return this.normalize(r.Attributes ?? {}, args.user_id);
      } catch (e) {
        if (!isConditionalCheckFailed(e)) throw e;
      }
    }
    throw new Error(
      `recordMuralParticipation: optimistic-concurrency retries exhausted for ${args.user_id}`,
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
      // Use a sentinel string for null prior_dld since DDB conditional
      // comparisons require a concrete value. We special-case below.
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

  private muralUpdate(
    args: RecordMuralParticipationArgs,
    prior: UserStatsRow | null,
    next: NextMuralState,
  ): UpdateCommand {
    const expr =
      "SET mural_total = :ct, mural_streak_current = :csc, mural_streak_longest = :csl, mural_last_id = :cli, updated_at = :now";
    const values: Record<string, unknown> = {
      ":ct": next.mural_total,
      ":csc": next.mural_streak_current,
      ":csl": next.mural_streak_longest,
      ":cli": next.mural_last_id,
      ":now": args.now_iso,
    };
    if (!prior) {
      return new UpdateCommand({
        TableName: this.table,
        Key: { user_id: args.user_id },
        UpdateExpression: expr,
        ConditionExpression: "attribute_not_exists(user_id)",
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      });
    }
    values[":prior_ct"] = prior.mural_total;
    if (prior.mural_last_id === null) {
      return new UpdateCommand({
        TableName: this.table,
        Key: { user_id: args.user_id },
        UpdateExpression: expr,
        ConditionExpression: "mural_total = :prior_ct AND attribute_not_exists(mural_last_id)",
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      });
    }
    values[":prior_cli"] = prior.mural_last_id;
    return new UpdateCommand({
      TableName: this.table,
      Key: { user_id: args.user_id },
      UpdateExpression: expr,
      ConditionExpression: "mural_total = :prior_ct AND mural_last_id = :prior_cli",
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
      mural_total: (item.mural_total as number) ?? 0,
      mural_streak_current: (item.mural_streak_current as number) ?? 0,
      mural_streak_longest: (item.mural_streak_longest as number) ?? 0,
      mural_last_id: (item.mural_last_id as string) ?? null,
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

  async recordMuralParticipation(
    args: RecordMuralParticipationArgs,
  ): Promise<UserStatsRow> {
    const prior = this.rows.get(args.user_id) ?? null;
    const next = nextMuralState(prior, args.mural_id);
    if (next.noOp && prior) return prior;
    const merged: UserStatsRow = {
      ...(prior ?? zeroRow(args.user_id, args.now_iso)),
      user_id: args.user_id,
      mural_total: next.mural_total,
      mural_streak_current: next.mural_streak_current,
      mural_streak_longest: next.mural_streak_longest,
      mural_last_id: next.mural_last_id,
      updated_at: args.now_iso,
    };
    this.rows.set(args.user_id, merged);
    return merged;
  }
}

export { previousDayUtc, isImmediatelyConsecutiveMural, nextDailyState, nextMuralState };
