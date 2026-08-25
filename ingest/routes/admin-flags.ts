import { logOutcome } from "../log-outcome.js";
import type { Route, RouteDeps, RouteRequest } from "../routes.js";

function json(
  status: number,
  body: unknown,
  headers?: Record<string, string>
): { kind: "json"; status: number; body: unknown; headers?: Record<string, string> } {
  return { kind: "json", status, body, headers };
}

export function adminFlagsRoutes(deps: RouteDeps): Route[] {
  return [
    {
      methods: ["GET"],
      pattern: /^\/admin\/merch\/flags$/,
      auth: "required",
      logName: "GET /admin/merch/flags",
      handler: async (req: RouteRequest, _params: string[], auth) => {
        const route = "GET /admin/merch/flags";
        if (!deps.admin.isAllowed(auth!.username)) {
          logOutcome({
            requestId: req.requestId,
            route,
            status: 403,
            duration_ms: Date.now() - req.t0,
            user_id: auth!.user_id,
            username: auth!.username,
            error_code: "forbidden",
          });
          return json(403, { error: "not authorised" });
        }
        if (!deps.admin.flagsStore) {
          logOutcome({
            requestId: req.requestId,
            route,
            status: 500,
            duration_ms: Date.now() - req.t0,
            user_id: auth!.user_id,
            username: auth!.username,
            error_code: "flags_store_not_wired",
          });
          return json(500, { error: "flags store not configured" });
        }
        const store = deps.admin.flagsStore as unknown as {
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
        logOutcome({
          requestId: req.requestId,
          route,
          status: 200,
          duration_ms: Date.now() - req.t0,
          user_id: auth!.user_id,
          username: auth!.username,
        });
        return json(200, body, { "Cache-Control": "private, no-store" });
      },
    },
    {
      methods: ["POST"],
      pattern: /^\/admin\/merch\/flags$/,
      auth: "required",
      logName: "POST /admin/merch/flags",
      handler: async (req: RouteRequest, _params: string[], auth) => {
        const route = "POST /admin/merch/flags";
        if (!deps.admin.isAllowed(auth!.username)) {
          logOutcome({
            requestId: req.requestId,
            route,
            status: 403,
            duration_ms: Date.now() - req.t0,
            user_id: auth!.user_id,
            username: auth!.username,
            error_code: "forbidden",
          });
          return json(403, { error: "not authorised" });
        }
        if (!deps.admin.flagsStore) {
          logOutcome({
            requestId: req.requestId,
            route,
            status: 500,
            duration_ms: Date.now() - req.t0,
            user_id: auth!.user_id,
            username: auth!.username,
            error_code: "flags_store_not_wired",
          });
          return json(500, { error: "flags store not configured" });
        }
        let raw: string;
        try {
          raw = await req.body();
        } catch {
          logOutcome({
            requestId: req.requestId,
            route,
            status: 400,
            duration_ms: Date.now() - req.t0,
            user_id: auth!.user_id,
            username: auth!.username,
            error_code: "bad_json",
          });
          return json(400, { error: "bad json body" });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          logOutcome({
            requestId: req.requestId,
            route,
            status: 400,
            duration_ms: Date.now() - req.t0,
            user_id: auth!.user_id,
            username: auth!.username,
            error_code: "bad_json",
          });
          return json(400, { error: "bad json body" });
        }
        const obj = parsed as Record<string, unknown>;
        let env: "prod" | "sandbox" | null = null;
        if (typeof obj.merch_env === "string") {
          const s = obj.merch_env.trim().toLowerCase();
          if (s === "prod" || s === "production" || s === "live") env = "prod";
          else if (s === "sandbox" || s === "test" || s === "dry-run" || s === "dry_run")
            env = "sandbox";
          else {
            logOutcome({
              requestId: req.requestId,
              route,
              status: 400,
              duration_ms: Date.now() - req.t0,
              user_id: auth!.user_id,
              username: auth!.username,
              error_code: "bad_merch_env",
            });
            return json(400, { error: "bad merch_env: expected prod or sandbox" });
          }
        } else if (typeof obj.merch_dry_run === "boolean") {
          env = obj.merch_dry_run ? "sandbox" : "prod";
        } else {
          logOutcome({
            requestId: req.requestId,
            route,
            status: 400,
            duration_ms: Date.now() - req.t0,
            user_id: auth!.user_id,
            username: auth!.username,
            error_code: "bad_merch_env",
          });
          return json(400, { error: "bad merch_env: expected prod or sandbox" });
        }
        const store = deps.admin.flagsStore as unknown as {
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
          row = await store.setMerchEnv(env, auth!.username);
        } else {
          row = await store.setFlag("merch_dry_run", env === "sandbox", auth!.username);
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
        logOutcome({
          requestId: req.requestId,
          route,
          status: 200,
          duration_ms: Date.now() - req.t0,
          user_id: auth!.user_id,
          username: auth!.username,
        });
        return json(200, body, { "Cache-Control": "private, no-store" });
      },
    },
  ];
}
