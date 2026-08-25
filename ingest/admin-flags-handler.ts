import type { AnyFlagsStore } from "../merch/flags-store.js";

export interface AdminFlagsConfig {
  flagsStore?: AnyFlagsStore;
}

export interface AdminFlagsResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  error_code?: string;
}

// GET /admin/merch/flags — returns { merch_env, merch_dry_run, updated_at, updated_by }
export async function handleGetAdminMerchFlags(cfg: AdminFlagsConfig): Promise<AdminFlagsResult> {
  if (!cfg.flagsStore) {
    return {
      status: 500,
      body: { error: "flags store not configured" },
      error_code: "flags_store_not_wired",
    };
  }
  const store = cfg.flagsStore as unknown as {
    getMerchEnv?: () => Promise<string>;
    getFlag: (flag: string) => Promise<{
      updated_at?: string | null;
      updated_by?: string | null;
      env?: string;
    } | null>;
  };
  let env: "prod" | "sandbox" = "sandbox";
  try {
    const maybe = await store.getMerchEnv?.();
    if (maybe === "prod" || maybe === "sandbox") env = maybe;
  } catch {
    // ignore
  }
  let row: { updated_at?: string | null; updated_by?: string | null } | null = null;
  try {
    const envRow = await store.getFlag("merch_env");
    if (envRow) row = envRow;
    else row = await store.getFlag("merch_dry_run");
  } catch {
    // ignore
  }
  const body = row
    ? {
        merch_env: env,
        merch_dry_run: env === "sandbox",
        updated_at: row.updated_at ?? null,
        updated_by: row.updated_by ?? null,
      }
    : {
        merch_env: env,
        merch_dry_run: env === "sandbox",
        updated_at: null,
        updated_by: null,
      };
  return { status: 200, body, headers: { "Cache-Control": "private, no-store" } };
}

// POST /admin/merch/flags — expects { merch_env: "prod"|"sandbox" } or { merch_dry_run: boolean }
export async function handleSetAdminMerchFlags(
  rawBody: string,
  cfg: AdminFlagsConfig,
  authUsername: string
): Promise<AdminFlagsResult> {
  if (!cfg.flagsStore) {
    return {
      status: 500,
      body: { error: "flags store not configured" },
      error_code: "flags_store_not_wired",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "bad json body" }, error_code: "bad_json" };
  }
  const obj = parsed as Record<string, unknown>;
  let env: "prod" | "sandbox" | null = null;
  if (typeof obj.merch_env === "string") {
    const s = obj.merch_env.trim().toLowerCase();
    if (s === "prod" || s === "production" || s === "live") env = "prod";
    else if (s === "sandbox" || s === "test" || s === "dry-run" || s === "dry_run") env = "sandbox";
    else {
      return {
        status: 400,
        body: { error: "bad merch_env: expected prod or sandbox" },
        error_code: "bad_merch_env",
      };
    }
  } else if (typeof obj.merch_dry_run === "boolean") {
    env = obj.merch_dry_run ? "sandbox" : "prod";
  } else {
    return {
      status: 400,
      body: { error: "bad merch_env: expected prod or sandbox" },
      error_code: "bad_merch_env",
    };
  }
  const store = cfg.flagsStore as unknown as {
    setMerchEnv?: (
      env: string,
      updatedBy: string
    ) => Promise<{ updated_at?: string; updated_by?: string }>;
    setFlag: (
      flag: string,
      enabled: boolean,
      updatedBy: string
    ) => Promise<{ updated_at?: string; updated_by?: string }>;
    getMerchEnv?: () => Promise<string>;
  };
  let row: { updated_at?: string; updated_by?: string } | null = null;
  if (store.setMerchEnv) {
    row = await store.setMerchEnv(env, authUsername);
  } else {
    row = await store.setFlag("merch_dry_run", env === "sandbox", authUsername);
  }
  let outEnv: "prod" | "sandbox" = env;
  try {
    const maybe = await store.getMerchEnv?.();
    if (maybe === "prod" || maybe === "sandbox") outEnv = maybe;
  } catch {
    // ignore
  }
  const body = {
    merch_env: outEnv,
    merch_dry_run: outEnv === "sandbox",
    updated_at: row?.updated_at ?? null,
    updated_by: row?.updated_by ?? null,
  };
  return { status: 200, body, headers: { "Cache-Control": "private, no-store" } };
}
