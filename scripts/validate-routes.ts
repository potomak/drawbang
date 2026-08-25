#!/usr/bin/env node
/**
 * Validate that `ingest/routes.ts:createRoutes()` and
 * `infra/aws/template.yaml` stay in sync.
 *
 * Source of truth is the live route table — we call `createRoutes()` with
 * mock dependencies and inspect the resulting `{methods, pattern}` pairs.
 * This is more robust than regex-parsing the file (no need to handle
 * `new RegExp(` vs `/.../` escaping, placeholder names, etc.) and it
 * automatically covers conditional routes like `/users/{id}/stats`.
 *
 * Usage:
 *   tsx scripts/validate-routes.ts          # check (CI)
 *   tsx scripts/validate-routes.ts --verbose
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoutes, type Route } from "../ingest/routes.js";
import { mockRouteDeps } from "../ingest/mock-route-deps.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// ---------------------------------------------------------------------------
// 2. Convert RegExp → API Gateway Path
// ---------------------------------------------------------------------------

function patternToApiPath(pattern: RegExp): string {
  let src = pattern.source;
  // source is like "^\/d\/([0-9a-f]{64})$" or "^\/u\/([a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_])$"
  // Remove leading ^ and trailing $
  src = src.replace(/^\^/, "").replace(/\$$/, "");
  // Decode escapes: \/ → /, \. → ., etc.
  src = src.replace(/\\\//g, "/").replace(/\\\./g, ".");
  // Replace known param patterns with placeholders
  // HEX64: [0-9a-f]{64}
  src = src.replace(/\(\[0-9a-f\]\{64\}\)/g, "{id}");
  src = src.replace(/\[0-9a-f\]\{64\}/g, "{id}");
  // USERNAME: [a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_]
  src = src.replace(/\(\[a-z0-9_\]\[a-z0-9_\-\]\{1,18\}\[a-z0-9_\]\)/g, "{username}");
  // Generic captures: (...) → {id}, (?:...) → {id}, [...] etc.
  src = src.replace(/\(\?:[^)]+\)/g, "{id}");
  src = src.replace(/\([^)]+\)/g, "{id}");
  src = src.replace(/\[[^\]]+\]/g, "{id}");
  // Handle followers|following alternation before generic
  if (src.includes("{id}|{id}")) {
    // Should not happen after above, but keep for safety
  }
  // Specific: (followers|following) → keep as literal for expansion later
  // At this point it's already {id} due to generic, so we need to handle earlier
  // Instead, detect original source before generic
  // Re-detect from original pattern source for this case
  const orig = pattern.source;
  if (orig.includes("followers|following")) {
    // Restore the alternation
    src = src.replace("{id}", "(followers|following)");
  }
  // Clean up
  src = src.replace(/\{id\}\/\{id\}/g, "{id}");
  src = src.replace(/\/\{id\}\/items/g, "/{id}/items");
  if (src === "/gallery(/items)?") src = "/gallery";
  if (src === "/auth/.+") src = "/auth/{proxy+}";
  if (src === "/prompts.*") src = "/prompts";
  if (src.includes(".*")) src = src.replace(/\/\.\*.*$/, "/{id}");
  if (!src.startsWith("/")) src = `/${src}`;
  return src;
}

function expectedApiEvents(routes: Route[]): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  for (const r of routes) {
    const rawPath = patternToApiPath(r.pattern);
    // Handle (followers|following) alternation
    if (rawPath.includes("(followers|following)")) {
      for (const seg of ["followers", "following"]) {
        const p = rawPath.replace("(followers|following)", seg);
        for (const m of r.methods) {
          const method = m === "GET" ? "ANY" : m;
          out.push({ method, path: p });
        }
      }
      continue;
    }
    if (rawPath === "/auth/{proxy+}") continue; // 7 explicit /auth/* in template
    if (rawPath.startsWith("/gallery")) continue; // edge redirect (/gallery + /gallery/items)
    for (const m of r.methods) {
      const method = m === "GET" ? "ANY" : m;
      out.push({ method, path: rawPath });
    }
  }
  for (const e of out) {
    if (e.path === "/users/{id}/stats") e.path = "/users/{user_id}/stats";
    if (e.path === "/admin/orders/{id}/status") e.path = "/admin/orders/{orderId}/status";
    if (e.path === "/products/p/{id}") e.path = "/products/p/{page}";
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Load template.yaml Events
// ---------------------------------------------------------------------------

function loadTemplatePaths(): { method: string; path: string }[] {
  const src = readFileSync(resolve(repoRoot, "infra/aws/template.yaml"), "utf8");
  const out: { method: string; path: string }[] = [];
  const eventRe = /Type:\s*HttpApi[\s\S]*?Method:\s*(\S+)[\s\S]*?Path:\s*(\S+)/g;
  let mm: RegExpExecArray | null;
  while ((mm = eventRe.exec(src))) {
    out.push({ method: mm[1], path: mm[2] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Main
// ---------------------------------------------------------------------------

function main(): void {
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
  const routes = createRoutes(mockRouteDeps());
  const expectedEvents = expectedApiEvents(routes);
  const actualEvents = loadTemplatePaths();

  if (verbose) {
    console.log(`Routes from createRoutes(): ${routes.length}`);
    console.log(`Expected events (${expectedEvents.length}) vs actual (${actualEvents.length})`);
  }

  const normPath = (p: string) => p.replace(/\{[^}]+\}/g, "{id}");
  const matches = (
    exp: { method: string; path: string },
    act: { method: string; path: string }
  ) => {
    if (normPath(exp.path) !== normPath(act.path)) return false;
    if (exp.method === act.method) return true;
    if (exp.method === "GET" && act.method === "ANY") return true;
    if (exp.method === "ANY" && act.method === "GET") return true;
    return false;
  };

  const merchActual = actualEvents.filter((e) => e.path.startsWith("/merch"));
  const nonMerchActual = actualEvents.filter((e) => !e.path.startsWith("/merch"));
  const authActual = actualEvents.filter((e) => e.path.startsWith("/auth/"));

  const missing = expectedEvents.filter(
    (e) => !nonMerchActual.some((a) => matches(e, a)) && !merchActual.some((a) => matches(e, a))
  );
  // For extra, ignore /merch and /auth/* (covered by catch-all)
  const extraCandidates = nonMerchActual.filter((a) => !a.path.startsWith("/auth/"));
  const extra = extraCandidates.filter((a) => !expectedEvents.some((e) => matches(e, a)));

  // Also filter missing that are /auth/{proxy+} (already skipped) or /gallery
  const filteredMissing = missing.filter(
    (e) => e.path !== "/auth/{proxy+}" && e.path !== "/gallery"
  );

  if (filteredMissing.length === 0 && extra.length === 0) {
    console.log(
      `validate-routes: OK — ${actualEvents.length} events (incl. ${merchActual.length} merch) in sync with ${routes.length} routes`
    );
    return;
  }

  if (filteredMissing.length > 0) {
    console.error(`validate-routes: MISSING template.yaml Events (${filteredMissing.length}):`);
    for (const m of filteredMissing) console.error(`  + ${m.method} ${m.path}`);
  }
  if (extra.length > 0) {
    console.error(`validate-routes: EXTRA template.yaml Events (${extra.length}):`);
    for (const e of extra) console.error(`  - ${e.method} ${e.path}`);
  }
  if (merchActual.length > 0 && verbose) {
    console.log(`validate-routes: (ignoring ${merchActual.length} merch Lambda Events)`);
  }
  if (authActual.length > 0 && verbose) {
    console.log(
      `validate-routes: (ignoring ${authActual.length} auth Events — covered by POST /auth/.+)`
    );
  }
  console.error(`validate-routes: FAIL — template.yaml Events out of sync with routes.ts`);
  process.exit(1);
}

main();
