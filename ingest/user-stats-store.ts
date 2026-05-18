import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  canvasClosesAt,
  canvasOpensAt,
  isCanvasIdValid,
} from "../config/canvases.js";

// Per-pubkey aggregated stats for streaks + badges (#115, #116).
//
// One row per pubkey. Two dimensions: daily drawings (any publish that lands
// a new gif under inbox/) and weekly canvas participation (any publish that
// places a tile via canvas_claim). Each dimension carries a running total
// (drives badges) and a streak (drives the "consecutive days/weeks" UX).
//
// Streak math is read-modify-write — the "yesterday vs other" branch can't
// be expressed as a single UpdateExpression. The Dynamo impl uses an
// optimistic-concurrency loop conditioned on the prior daily_last_date /
// canvas_last_id so concurrent publishes converge correctly.
//
// Idempotency lives at the call site: handleIngest only hooks the daily
// counter when !alreadyHere (so re-publishes of an existing gif don't
// double-count), and the canvas counter sees same-canvas re-publishes as
// no-ops here in the store (canvas_last_id === canvas_id short-circuit).

export interface UserStatsRow {
  pubkey: string;
  daily_total: number;
  daily_streak_current: number;
  daily_streak_longest: number;
  daily_last_date: string | null;
  canvas_total: number;
  canvas_streak_current: number;
  canvas_streak_longest: number;
  canvas_last_id: string | null;
  updated_at: string;
}

export interface RecordDailyDrawingArgs {
  pubkey: string;
  // ISO YYYY-MM-DD (UTC). Caller derives this from nowISO.slice(0, 10).
  date_utc: string;
  now_iso: string;
}

export interface RecordCanvasParticipationArgs {
  pubkey: string;
  canvas_id: string;
  now_iso: string;
}

export interface UserStatsStore {
  // Bumps daily_total + advances streak for a new drawing published on
  // date_utc. Same-day re-publishes only bump the total (consecutive-day
  // logic doesn't re-fire). Caller MUST gate by gif-novelty (!alreadyHere)
  // so re-publishes of an existing gif don't reach this method.
  recordDailyDrawing(args: RecordDailyDrawingArgs): Promise<UserStatsRow>;
  // Bumps canvas_total + advances streak the first time pubkey publishes
  // into canvas_id. Additional tiles into the same canvas are no-ops at
  // this layer.
  recordCanvasParticipation(args: RecordCanvasParticipationArgs): Promise<UserStatsRow>;
  get(pubkey: string): Promise<UserStatsRow | null>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function previousDayUtc(dateUtc: string): string {
  if (!DATE_RE.test(dateUtc)) throw new Error(`invalid date_utc: ${dateUtc}`);
  const [y, m, d] = dateUtc.split("-").map((p) => parseInt(p, 10));
  const t = Date.UTC(y, m - 1, d) - 86_400_000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// True when `prev` is the canvas that ended exactly when `next` opens. ISO
// week math lives in config/canvases — we just compare boundary timestamps.
function isImmediatelyConsecutiveCanvas(prev: string, next: string): boolean {
  if (!isCanvasIdValid(prev) || !isCanvasIdValid(next)) return false;
  return canvasClosesAt(prev).getTime() === canvasOpensAt(next).getTime();
}

function zeroRow(pubkey: string, nowIso: string): UserStatsRow {
  return {
    pubkey,
    daily_total: 0,
    daily_streak_current: 0,
    daily_streak_longest: 0,
    daily_last_date: null,
    canvas_total: 0,
    canvas_streak_current: 0,
    canvas_streak_longest: 0,
    canvas_last_id: null,
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

interface NextCanvasState {
  canvas_total: number;
  canvas_streak_current: number;
  canvas_streak_longest: number;
  canvas_last_id: string;
  noOp: boolean; // true when canvas_id matches canvas_last_id
}

function nextCanvasState(prior: UserStatsRow | null, canvasId: string): NextCanvasState {
  const base = prior ?? zeroRow("", "");
  if (base.canvas_last_id === canvasId) {
    return {
      canvas_total: base.canvas_total,
      canvas_streak_current: base.canvas_streak_current,
      canvas_streak_longest: base.canvas_streak_longest,
      canvas_last_id: canvasId,
      noOp: true,
    };
  }
  const consecutive =
    base.canvas_last_id !== null &&
    isImmediatelyConsecutiveCanvas(base.canvas_last_id, canvasId);
  const newStreak = consecutive ? base.canvas_streak_current + 1 : 1;
  return {
    canvas_total: base.canvas_total + 1,
    canvas_streak_current: newStreak,
    canvas_streak_longest: Math.max(base.canvas_streak_longest, newStreak),
    canvas_last_id: canvasId,
    noOp: false,
  };
}

// -- DynamoDB -----------------------------------------------------------------

export interface DynamoUserStatsStoreOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
  // Max retries on optimistic-concurrency conflict before throwing. Defaults
  // to 5 — concurrent publishes by the same pubkey are rare in practice (the
  // canvas branch is already cooldown-gated), so 5 is generous.
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

  async get(pubkey: string): Promise<UserStatsRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pubkey } }),
    );
    if (!r.Item) return null;
    return this.normalize(r.Item, pubkey);
  }

  async recordDailyDrawing(args: RecordDailyDrawingArgs): Promise<UserStatsRow> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const prior = await this.get(args.pubkey);
      const next = nextDailyState(prior, args.date_utc);
      try {
        const r = await this.doc.send(this.dailyUpdate(args, prior, next));
        return this.normalize(r.Attributes ?? {}, args.pubkey);
      } catch (e) {
        if (!isConditionalCheckFailed(e)) throw e;
      }
    }
    throw new Error(
      `recordDailyDrawing: optimistic-concurrency retries exhausted for ${args.pubkey}`,
    );
  }

  async recordCanvasParticipation(
    args: RecordCanvasParticipationArgs,
  ): Promise<UserStatsRow> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const prior = await this.get(args.pubkey);
      const next = nextCanvasState(prior, args.canvas_id);
      if (next.noOp) return prior ?? zeroRow(args.pubkey, args.now_iso);
      try {
        const r = await this.doc.send(this.canvasUpdate(args, prior, next));
        return this.normalize(r.Attributes ?? {}, args.pubkey);
      } catch (e) {
        if (!isConditionalCheckFailed(e)) throw e;
      }
    }
    throw new Error(
      `recordCanvasParticipation: optimistic-concurrency retries exhausted for ${args.pubkey}`,
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
      : "attribute_not_exists(pubkey)";
    if (prior) {
      values[":prior_dt"] = prior.daily_total;
      // Use a sentinel string for null prior_dld since DDB conditional
      // comparisons require a concrete value. We special-case below.
      if (prior.daily_last_date === null) {
        values[":prior_dt_only"] = prior.daily_total;
        return new UpdateCommand({
          TableName: this.table,
          Key: { pubkey: args.pubkey },
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
      Key: { pubkey: args.pubkey },
      UpdateExpression: expr,
      ConditionExpression: condition,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    });
  }

  private canvasUpdate(
    args: RecordCanvasParticipationArgs,
    prior: UserStatsRow | null,
    next: NextCanvasState,
  ): UpdateCommand {
    const expr =
      "SET canvas_total = :ct, canvas_streak_current = :csc, canvas_streak_longest = :csl, canvas_last_id = :cli, updated_at = :now";
    const values: Record<string, unknown> = {
      ":ct": next.canvas_total,
      ":csc": next.canvas_streak_current,
      ":csl": next.canvas_streak_longest,
      ":cli": next.canvas_last_id,
      ":now": args.now_iso,
    };
    if (!prior) {
      return new UpdateCommand({
        TableName: this.table,
        Key: { pubkey: args.pubkey },
        UpdateExpression: expr,
        ConditionExpression: "attribute_not_exists(pubkey)",
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      });
    }
    values[":prior_ct"] = prior.canvas_total;
    if (prior.canvas_last_id === null) {
      return new UpdateCommand({
        TableName: this.table,
        Key: { pubkey: args.pubkey },
        UpdateExpression: expr,
        ConditionExpression: "canvas_total = :prior_ct AND attribute_not_exists(canvas_last_id)",
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      });
    }
    values[":prior_cli"] = prior.canvas_last_id;
    return new UpdateCommand({
      TableName: this.table,
      Key: { pubkey: args.pubkey },
      UpdateExpression: expr,
      ConditionExpression: "canvas_total = :prior_ct AND canvas_last_id = :prior_cli",
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    });
  }

  private normalize(item: Record<string, unknown>, pubkey: string): UserStatsRow {
    return {
      pubkey: (item.pubkey as string) ?? pubkey,
      daily_total: (item.daily_total as number) ?? 0,
      daily_streak_current: (item.daily_streak_current as number) ?? 0,
      daily_streak_longest: (item.daily_streak_longest as number) ?? 0,
      daily_last_date: (item.daily_last_date as string) ?? null,
      canvas_total: (item.canvas_total as number) ?? 0,
      canvas_streak_current: (item.canvas_streak_current as number) ?? 0,
      canvas_streak_longest: (item.canvas_streak_longest as number) ?? 0,
      canvas_last_id: (item.canvas_last_id as string) ?? null,
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

  async get(pubkey: string): Promise<UserStatsRow | null> {
    return this.rows.get(pubkey) ?? null;
  }

  async recordDailyDrawing(args: RecordDailyDrawingArgs): Promise<UserStatsRow> {
    const prior = this.rows.get(args.pubkey) ?? null;
    const next = nextDailyState(prior, args.date_utc);
    const merged: UserStatsRow = {
      ...(prior ?? zeroRow(args.pubkey, args.now_iso)),
      pubkey: args.pubkey,
      daily_total: next.daily_total,
      daily_streak_current: next.daily_streak_current,
      daily_streak_longest: next.daily_streak_longest,
      daily_last_date: next.daily_last_date,
      updated_at: args.now_iso,
    };
    this.rows.set(args.pubkey, merged);
    return merged;
  }

  async recordCanvasParticipation(
    args: RecordCanvasParticipationArgs,
  ): Promise<UserStatsRow> {
    const prior = this.rows.get(args.pubkey) ?? null;
    const next = nextCanvasState(prior, args.canvas_id);
    if (next.noOp && prior) return prior;
    const merged: UserStatsRow = {
      ...(prior ?? zeroRow(args.pubkey, args.now_iso)),
      pubkey: args.pubkey,
      canvas_total: next.canvas_total,
      canvas_streak_current: next.canvas_streak_current,
      canvas_streak_longest: next.canvas_streak_longest,
      canvas_last_id: next.canvas_last_id,
      updated_at: args.now_iso,
    };
    this.rows.set(args.pubkey, merged);
    return merged;
  }
}

export { previousDayUtc, isImmediatelyConsecutiveCanvas, nextDailyState, nextCanvasState };
