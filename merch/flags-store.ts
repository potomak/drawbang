import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

export interface Flag {
  flag: string;
  enabled?: boolean;
  // Alias for enabled, for backwards-compat with callers that use `value`.
  value?: boolean;
  // Env name for merch_env — prod vs sandbox. Present only on the
  // merch_env flag; merch_dry_run uses enabled/value.
  env?: MerchEnv;
  updated_by?: string;
  updated_at?: string;
}

export interface FlagRow {
  flag: string;
  value?: boolean;
  enabled?: boolean;
  env?: string;
  updated_by?: string;
  updated_at: string;
}

export interface FlagsStoreConfig {
  tableName: string;
  client?: DynamoDBClient;
  // Test seam: skip DynamoDBDocumentClient.from() and use supplied
  // docClient directly. Mirrors OrdersStore / ProductCountersStore so
  // stubbing client.send doesn't miss the DocumentClient middleware.
  docClient?: Pick<DynamoDBDocumentClient, "send">;
  // Optional clock/timestamp seams for deterministic tests.
  // clock controls the 5 s cache expiry (ms since epoch); now controls
  // the ISO timestamp written by setFlag.
  clock?: () => number;
  now?: () => string;
  cacheTtlMs?: number;
}

const CACHE_TTL_MS = 5_000;

export type MerchEnv = "prod" | "sandbox";

export const MERCH_ENV_FLAG = "merch_env";
export const MERCH_DRY_RUN_FLAG = "merch_dry_run";
export const FLAG_MERCH_DRY_RUN = MERCH_DRY_RUN_FLAG;
export const FLAG_MERCH_ENV = MERCH_ENV_FLAG;

export class FlagsStore {
  private readonly doc: Pick<DynamoDBDocumentClient, "send">;
  private readonly tableName: string;
  private readonly clock: () => number;
  private readonly nowIso: () => string;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { value: Flag | null; expiresAt: number }>();

  constructor(cfg: FlagsStoreConfig) {
    if (cfg.docClient) {
      this.doc = cfg.docClient;
    } else {
      const client = cfg.client ?? new DynamoDBClient({});
      this.doc = DynamoDBDocumentClient.from(client);
    }
    this.tableName = cfg.tableName;
    this.clock = cfg.clock ?? Date.now;
    this.nowIso = cfg.now ?? (() => new Date().toISOString());
    this.cacheTtlMs = cfg.cacheTtlMs ?? CACHE_TTL_MS;
  }

  /**
   * Read a flag by PK `flag`. Results are cached in-memory for 5 s per
   * flag key so hot paths (merch checkout webhook, admin GET) don't pay
   * a DDB round-trip on every call. Cache is per-instance (i.e. per
   * Lambda container) and includes null (flag not yet seeded) so a
   * missing row doesn't hammer DDB either.
   */
  async getFlag(flag: string): Promise<Flag | null> {
    const nowMs = this.clock();
    const cached = this.cache.get(flag);
    if (cached && cached.expiresAt > nowMs) {
      return cached.value ? normalizeFlag(cached.value) : null;
    }
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { flag },
      })
    );
    const raw = out.Item as Record<string, unknown> | undefined;
    let item: Flag | null = null;
    if (raw && typeof raw.flag === "string") {
      item = normalizeRawFlag(raw);
    }
    this.cache.set(flag, { value: item, expiresAt: nowMs + this.cacheTtlMs });
    return item ? normalizeFlag(item) : null;
  }

  /**
   * Upsert a flag. Uses a PutItem (unconditional) so the same call
   * creates the row when absent and updates it when present — the
   * merch_dry_run seed and subsequent admin toggles both go through
   * here. Writes `updated_at`/`updated_by` for audit and refreshes
   * the in-memory cache so a subsequent getFlag within the 5 s window
   * returns the fresh value without a DDB read.
   *
   * Supports both call shapes:
   *   setFlag(flag, enabled, "username")
   *   setFlag(flag, enabled, { updated_by: "username", now: "ISO" })
   * for compatibility across callers. Returns the written Flag for
   * callers that need the new value.
   */
  async setFlag(
    flag: string,
    enabled: boolean,
    updatedBy?: string | { updated_by?: string; updatedBy?: string; now?: string }
  ): Promise<Flag> {
    let updated_by: string | undefined;
    let nowOverride: string | undefined;
    if (typeof updatedBy === "string") {
      updated_by = updatedBy;
    } else if (updatedBy && typeof updatedBy === "object") {
      const o = updatedBy as Record<string, unknown>;
      updated_by = (o.updated_by as string) ?? (o.updatedBy as string);
      nowOverride = o.now as string | undefined;
    }
    const now = nowOverride ?? this.nowIso();
    const item: Flag = {
      flag,
      enabled,
      value: enabled,
      updated_by,
      updated_at: now,
    };
    // Store with both `enabled` and `value` for backwards compat, plus `flag`.
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          flag,
          enabled,
          value: enabled,
          updated_at: now,
          ...(updated_by ? { updated_by } : {}),
        },
      })
    );
    // Refresh cache so the next getFlag is warm.
    this.cache.set(flag, { value: { ...item }, expiresAt: this.clock() + this.cacheTtlMs });
    return { ...item };
  }

  /** Test helper: evict a single flag from the cache. */
  clearCache(flag?: string): void {
    if (flag) this.cache.delete(flag);
    else this.cache.clear();
  }

  // Convenience: return boolean value for merch_dry_run, defaulting to true (dry-run safe) when missing.
  // Deprecated — prefer getMerchEnv(). Kept for backwards compat with callers
  // that still read merch_dry_run.
  async getMerchDryRunValue(): Promise<boolean> {
    const env = await this.getMerchEnv();
    return env === "sandbox";
  }

  async getMerchEnv(): Promise<MerchEnv> {
    // New flag first — if merch_env exists its env string wins.
    const envRow = await this.getFlag(MERCH_ENV_FLAG);
    if (envRow?.env) {
      const n = normalizeEnv(envRow.env);
      if (n) return n;
    }
    // Fall back to legacy boolean flag: true → sandbox, false → prod.
    const dryRow = await this.getFlag(MERCH_DRY_RUN_FLAG);
    if (dryRow) {
      const b = dryRow.enabled ?? dryRow.value;
      if (typeof b === "boolean") return b ? "sandbox" : "prod";
    }
    // Missing flag → sandbox (safe, matches dry-run default true).
    return "sandbox";
  }

  async setMerchEnv(
    env: MerchEnv,
    updatedBy?: string | { updated_by?: string; updatedBy?: string; now?: string },
  ): Promise<Flag> {
    const n = normalizeEnv(env) ?? "sandbox";
    let updated_by: string | undefined;
    let nowOverride: string | undefined;
    if (typeof updatedBy === "string") {
      updated_by = updatedBy;
    } else if (updatedBy && typeof updatedBy === "object") {
      const o = updatedBy as Record<string, unknown>;
      updated_by = (o.updated_by as string) ?? (o.updatedBy as string);
      nowOverride = o.now as string | undefined;
    }
    const now = nowOverride ?? this.nowIso();
    const item: Flag = {
      flag: MERCH_ENV_FLAG,
      env: n,
      enabled: n === "sandbox",
      value: n === "sandbox",
      updated_by,
      updated_at: now,
    };
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          flag: MERCH_ENV_FLAG,
          env: n,
          enabled: n === "sandbox",
          value: n === "sandbox",
          updated_at: now,
          ...(updated_by ? { updated_by } : {}),
        },
      }),
    );
    this.cache.set(MERCH_ENV_FLAG, { value: { ...item }, expiresAt: this.clock() + this.cacheTtlMs });
    // Keep legacy merch_dry_run row in sync so old readers see the same env.
    const dryEnabled = n === "sandbox";
    const dryItem: Flag = {
      flag: MERCH_DRY_RUN_FLAG,
      enabled: dryEnabled,
      value: dryEnabled,
      updated_by,
      updated_at: now,
    };
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          flag: MERCH_DRY_RUN_FLAG,
          enabled: dryEnabled,
          value: dryEnabled,
          updated_at: now,
          ...(updated_by ? { updated_by } : {}),
        },
      }),
    );
    this.cache.set(MERCH_DRY_RUN_FLAG, { value: { ...dryItem }, expiresAt: this.clock() + this.cacheTtlMs });
    return { ...item };
  }
}

function normalizeEnv(raw: unknown): MerchEnv | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s === "prod" || s === "production" || s === "live") return "prod";
  if (s === "sandbox" || s === "test" || s === "dry-run" || s === "dry_run") return "sandbox";
  return null;
}

function normalizeRawFlag(raw: Record<string, unknown>): Flag {
  const flag = String(raw.flag);
  const envRaw = raw.env as unknown;
  const enabledRaw = raw.enabled as unknown;
  const valueRaw = raw.value as unknown;
  const env = typeof envRaw === "string" ? (normalizeEnv(envRaw) ?? undefined) : undefined;
  // For merch_env we store env string; for legacy merch_dry_run we store boolean.
  // Keep env when present, and still populate enabled/value for compat.
  let enabled: boolean | undefined;
  if (typeof enabledRaw === "boolean") enabled = enabledRaw;
  else if (typeof valueRaw === "boolean") enabled = valueRaw;
  else if (env) enabled = env === "sandbox";
  else if (enabledRaw !== undefined || valueRaw !== undefined) enabled = Boolean(enabledRaw ?? valueRaw);
  return {
    flag,
    ...(env ? { env } : {}),
    ...(enabled !== undefined ? { enabled, value: enabled } : {}),
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
    updated_by: typeof raw.updated_by === "string" ? raw.updated_by : undefined,
  };
}

function normalizeFlag(f: Flag): Flag {
  const env = f.env ? (normalizeEnv(f.env) ?? undefined) : undefined;
  const enabled = f.enabled ?? f.value ?? (env ? env === "sandbox" : undefined);
  return {
    ...f,
    ...(env ? { env } : {}),
    ...(enabled !== undefined ? { enabled, value: enabled } : {}),
  };
}

// In-memory variant for dev-server and tests. Mirrors the same 5s cache
// semantics so the prod vs dev timing difference doesn't hide bugs.
export class MemoryFlagsStore {
  private readonly store = new Map<string, Flag>();
  private readonly cache = new Map<string, { value: Flag | null; expiresAt: number }>();
  private readonly clock: () => number;
  private readonly nowIso: () => string;
  private readonly cacheTtlMs: number;

  constructor(opts: { clock?: () => number; now?: () => string; cacheTtlMs?: number } = {}) {
    this.clock = opts.clock ?? Date.now;
    this.nowIso = opts.now ?? (() => new Date().toISOString());
    this.cacheTtlMs = opts.cacheTtlMs ?? CACHE_TTL_MS;
  }

  async getFlag(flag: string): Promise<Flag | null> {
    const nowMs = this.clock();
    const cached = this.cache.get(flag);
    if (cached && cached.expiresAt > nowMs) {
      return cached.value ? normalizeFlag(cached.value) : null;
    }
    const raw = this.store.get(flag) ?? null;
    const item = raw ? normalizeFlag(raw) : null;
    this.cache.set(flag, { value: item, expiresAt: nowMs + this.cacheTtlMs });
    return item;
  }

  async setFlag(
    flag: string,
    enabled: boolean,
    updatedBy?: string | { updated_by?: string; updatedBy?: string; now?: string }
  ): Promise<Flag> {
    let updated_by: string | undefined;
    let nowOverride: string | undefined;
    if (typeof updatedBy === "string") {
      updated_by = updatedBy;
    } else if (updatedBy && typeof updatedBy === "object") {
      const o = updatedBy as Record<string, unknown>;
      updated_by = (o.updated_by as string) ?? (o.updatedBy as string);
      nowOverride = o.now as string | undefined;
    }
    const now = nowOverride ?? this.nowIso();
    const item: Flag = {
      flag,
      enabled,
      value: enabled,
      updated_at: now,
      ...(updated_by ? { updated_by } : {}),
    };
    this.store.set(flag, { ...item });
    this.cache.set(flag, { value: { ...item }, expiresAt: this.clock() + this.cacheTtlMs });
    return { ...item };
  }

  clearCache(flag?: string): void {
    if (flag) this.cache.delete(flag);
    else this.cache.clear();
  }

  async getMerchDryRunValue(): Promise<boolean> {
    const env = await this.getMerchEnv();
    return env === "sandbox";
  }

  async getMerchEnv(): Promise<MerchEnv> {
    const envRow = await this.getFlag(MERCH_ENV_FLAG);
    if (envRow?.env) {
      const n = normalizeEnv(envRow.env);
      if (n) return n;
    }
    const dryRow = await this.getFlag(MERCH_DRY_RUN_FLAG);
    if (dryRow) {
      const b = dryRow.enabled ?? dryRow.value;
      if (typeof b === "boolean") return b ? "sandbox" : "prod";
    }
    return "sandbox";
  }

  async setMerchEnv(
    env: MerchEnv,
    updatedBy?: string | { updated_by?: string; updatedBy?: string; now?: string },
  ): Promise<Flag> {
    const n = normalizeEnv(env) ?? "sandbox";
    let updated_by: string | undefined;
    let nowOverride: string | undefined;
    if (typeof updatedBy === "string") {
      updated_by = updatedBy;
    } else if (updatedBy && typeof updatedBy === "object") {
      const o = updatedBy as Record<string, unknown>;
      updated_by = (o.updated_by as string) ?? (o.updatedBy as string);
      nowOverride = o.now as string | undefined;
    }
    const now = nowOverride ?? this.nowIso();
    const item: Flag = {
      flag: MERCH_ENV_FLAG,
      env: n,
      enabled: n === "sandbox",
      value: n === "sandbox",
      updated_by,
      updated_at: now,
    };
    this.store.set(MERCH_ENV_FLAG, { ...item });
    this.cache.set(MERCH_ENV_FLAG, { value: { ...item }, expiresAt: this.clock() + this.cacheTtlMs });
    const dryEnabled = n === "sandbox";
    const dryItem: Flag = {
      flag: MERCH_DRY_RUN_FLAG,
      enabled: dryEnabled,
      value: dryEnabled,
      updated_by,
      updated_at: now,
    };
    this.store.set(MERCH_DRY_RUN_FLAG, { ...dryItem });
    this.cache.set(MERCH_DRY_RUN_FLAG, { value: { ...dryItem }, expiresAt: this.clock() + this.cacheTtlMs });
    return { ...item };
  }

  seed(flag: Flag): void {
    this.store.set(flag.flag, normalizeFlag(flag));
    this.cache.delete(flag.flag);
  }
}

export type AnyFlagsStore = FlagsStore | MemoryFlagsStore;
