import { logOutcome } from "../log-outcome.js";
import type { Route, RouteDeps, RouteRequest } from "../routes.js";
import { handleGetAdminMerchFlags, handleSetAdminMerchFlags } from "../admin-flags-handler.js";

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
        const result = await handleGetAdminMerchFlags({
          flagsStore: deps.admin.flagsStore,
        });
        logOutcome({
          requestId: req.requestId,
          route,
          status: result.status,
          duration_ms: Date.now() - req.t0,
          user_id: auth!.user_id,
          username: auth!.username,
          error_code: result.error_code,
        });
        return json(result.status, result.body, result.headers);
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
        const result = await handleSetAdminMerchFlags(
          raw,
          { flagsStore: deps.admin.flagsStore },
          auth!.username
        );
        logOutcome({
          requestId: req.requestId,
          route,
          status: result.status,
          duration_ms: Date.now() - req.t0,
          user_id: auth!.user_id,
          username: auth!.username,
          error_code: result.error_code,
        });
        return json(result.status, result.body, result.headers);
      },
    },
  ];
}
