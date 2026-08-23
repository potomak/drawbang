import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

export interface Flag {
  flag: string;
  enabled: boolean;
  // Alias for enabled, for backwards-compat with callers that use `value`.
  value?: boolean;
  updated_by?: string;
  updated_at?: string;
}

export interface FlagRow {
  flag: string;
  value: boolean;
  enabled?: boolean;
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

export const MERCH_DRY_RUN_FLAG = "merch_dry_run";
export const FLAG_MERCH_DRY_RUN = MERCH_DRY_RUN_FLAG;

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
      }),
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
    updatedBy?: string | { updated_by?: string; updatedBy?: string; now?: string },
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
        Item: { flag, enabled, value: enabled, updated_at: now, ...(updated_by ? { updated_by } : {}) },
      }),
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
  async getMerchDryRunValue(): Promise<boolean> {
    const flag = await this.getFlag(MERCH_DRY_RUN_FLAG);
    if (!flag) return true;
    return flag.enabled ?? flag.value ?? true;
  }
}

function normalizeRawFlag(raw: Record<string, unknown>): Flag {
  const flag = String(raw.flag);
  const enabledRaw = raw.enabled as unknown;
  const valueRaw = raw.value as unknown;
  const enabled = typeof enabledRaw === "boolean" ? enabledRaw : typeof valueRaw === "boolean" ? valueRaw : Boolean(enabledRaw ?? valueRaw);
  return {
    flag,
    enabled,
    value: enabled,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
    updated_by: typeof raw.updated_by === "string" ? raw.updated_by : undefined,
  };
}

function normalizeFlag(f: Flag): Flag {
  const enabled = f.enabled ?? f.value ?? false;
  return { ...f, enabled, value: enabled };
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
    updatedBy?: string | { updated_by?: string; updatedBy?: string; now?: string },
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
    const item: Flag = { flag, enabled, value: enabled, updated_at: now, ...(updated_by ? { updated_by } : {}) };
    this.store.set(flag, { ...item });
    this.cache.set(flag, { value: { ...item }, expiresAt: this.clock() + this.cacheTtlMs });
    return { ...item };
  }

  clearCache(flag?: string): void {
    if (flag) this.cache.delete(flag);
    else this.cache.clear();
  }

  async getMerchDryRunValue(): Promise<boolean> {
    const flag = await this.getFlag(MERCH_DRY_RUN_FLAG);
    if (!flag) return true;
    return flag.enabled ?? flag.value ?? true;
  }

  seed(flag: Flag): void {
    this.store.set(flag.flag, normalizeFlag(flag));
    this.cache.delete(flag.flag);
  }
}

export type AnyFlagsStore = FlagsStore | MemoryFlagsStore;
