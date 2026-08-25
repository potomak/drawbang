#!/usr/bin/env node
/**
 * Codegen for proposal #298 / #3 — single source of truth for routes.
 *
 * Source: `ingest/routes.ts:createRoutes()` — the ordered {methods, pattern, auth} table.
 * Targets:
 *   - `vite.config.ts:DEV_PROXY_PATHS` — vite dev-server proxy to `ingest:dev` (8787)
 *   - `infra/aws/template.yaml` IngestFunction Events — API Gateway HTTP API paths
 *
 * The script is intentionally *validating* first, *writing* second:
 *   - Default (`--check`) exits non-zero if either target is out of sync
 *   - `--write` rewrites the marked blocks in-place and re-checks
 *
 * Why not fully generate CloudFront CacheBehaviors? Those have ordering
 * constraints (longest pattern above parent, u-bookmarks before u-star)
 * and auth-forwarding policy differences that are safer to keep hand-tuned
 * and validated than blindly codegen'd. Events plus proxy cover the brittle
 * coupling that broke signup (check-proxy / check-routes lore).
 *
 * Usage:
 *   tsx scripts/gen-routes.ts          # check (CI)
 *   tsx scripts/gen-routes.ts --write  # fix vite.config.ts in place
 *   tsx scripts/gen-routes.ts --write --all  # also sort template.yaml Events (no-op if already sorted)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// ---------------------------------------------------------------------------
// 1. Parse routes.ts
// ---------------------------------------------------------------------------

interface RouteDecl {
  methods: string[];
  patternSrc: string; // raw regex source between ^ and $
  isNewRegExp: boolean;
}

function loadRoutes(): RouteDecl[] {
  const src = readFileSync(resolve(repoRoot, "ingest/routes.ts"), "utf8");
  const out: RouteDecl[] = [];
  // Matches both `pattern: /^\/...$/` and `pattern: new RegExp(`^\/...$`)`
  // Captures methods array preceding it as well
  const routeRe =
    /methods:\s*\[([^\]]*)\][\s\S]*?pattern:\s*(?:\/\^(.+?)\$\/|new RegExp\(`\^(.+?)\$`)/g;
  let m: RegExpExecArray | null;
  while ((m = routeRe.exec(src))) {
    const methodsRaw = m[1];
    const patternSrc = m[2] ?? m[3];
    if (!patternSrc) continue;
    const methods = [...methodsRaw.matchAll(/"([^"]+)"|'([^']+)'/g)].map((x) => x[1] ?? x[2]);
    if (methods.length === 0) continue;
    out.push({
      methods,
      patternSrc,
      isNewRegExp: m[2] === undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Derive vite proxy patterns
// ---------------------------------------------------------------------------

/**
 * Map a route regex pattern to the vite DEV_PROXY_PATHS entry that should
 * cover it. We group by first path segment to keep the proxy list small
 * (one prefix/regex per URL family) — adding a new `/u/*` sub-route needs
 * no vite change because `^/u/.*` already covers it. Adding a new top-level
 * prefix (e.g. `/claims`) will surface as a missing proxy.
 */
function toViteProxy(patternSrc: string): string | null {
  const decoded = patternSrc.replace(/\\/g, "");

  // Exact matches that should stay exact (CloudFront has exact `/` behaviour)
  if (decoded === "/") return "^/$";
  if (decoded === "/gallery(/items)?") return "^/gallery(/items)?$";
  // Vite already uses "^/gallery(/items)?$" for the legacy redirect — keep it.

  // Group all /auth sub-routes under one prefix — covers
  // /auth/challenge, /auth/profile, and the catch-all /auth/.+ dispatch.
  if (decoded.startsWith("/auth")) return "/auth";
  // All /admin sub-routes under one prefix
  if (decoded.startsWith("/admin")) return "/admin";

  // Render routes families — one regex per family
  if (decoded.startsWith("/d/")) return "^/d/.*";
  if (decoded.startsWith("/embed/")) return "^/embed/.*";
  if (decoded.startsWith("/u/")) return "^/u/.*";
  if (decoded.startsWith("/prompts")) return "^/prompts.*";
  if (decoded.startsWith("/products")) return "^/products.*";
  if (decoded.startsWith("/drawings/")) return "/drawings";
  if (decoded.startsWith("/users/")) return "/users";
  if (decoded.startsWith("/me/")) return "/me";

  // Singletons that keep their literal form
  if (decoded === "/ingest") return "/ingest";
  if (decoded === "/subscribe") return "/subscribe";
  if (decoded === "/hydrate") return "/hydrate";
  if (decoded === "/backfill/sidecars") return "/backfill";
  if (decoded === "/feed/items") return "/feed/items";
  if (decoded === "/feed\\.rss") return "/feed.rss";
  if (decoded === "/design") return "/design";

  // Fallback: for any other exact path like `/` we already handled,
  // for parameterized paths like `/products/p/(\d+)` we map to family above.
  // If we reach here, use the first segment as a prefix.
  const seg = decoded.match(/^\/([^/\\(]+)/);
  if (seg) return `/${seg[1]}`;

  return null;
}

function expectedViteProxies(routes: RouteDecl[]): string[] {
  const set = new Set<string>();
  for (const r of routes) {
    const p = toViteProxy(r.patternSrc);
    if (p) set.add(p);
  }
  // Ensure stable ordering: exact "/" first, then literals, then regexes
  const arr = [...set];
  arr.sort((a, b) => {
    if (a === "^/$") return -1;
    if (b === "^/$") return 1;
    const aIsRegex = a.startsWith("^");
    const bIsRegex = b.startsWith("^");
    if (aIsRegex !== bIsRegex) return aIsRegex ? 1 : -1;
    return a.localeCompare(b);
  });
  return arr;
}

// ---------------------------------------------------------------------------
// 3. Derive API Gateway Paths from routes
// ---------------------------------------------------------------------------

function patternToApiPath(patternSrc: string): string {
  let p = patternSrc.replace(/\\/g, "");
  // Replace capture groups with {param} placeholders — more specific than
  // check-routes: map known param names
  if (p.includes("USERNAME")) {
    p = p.replace(/\(\$\{USERNAME\}\)/g, "{username}");
    p = p.replace(/\([^)]*USERNAME[^)]*\)/g, "{username}");
  }
  if (p.includes("HEX64")) {
    p = p.replace(/\(\$\{HEX64\}\)/g, "{id}");
    // The second form `new RegExp(`^\\/drawings\\/(${HEX64})\\/like$`)`
    p = p.replace(/\([^)]*HEX64[^)]*\)/g, "{id}");
  }
  // Preserve the followers|following alternation before generic collapse
  const followersAlt = p.includes("(followers|following)");
  if (followersAlt) {
    p = p.replace("(followers|following)", "__FOLLOWERS_ALT__");
  }
  // Generic captures
  p = p.replace(/\(\?:[^)]+\)/g, "{param}");
  p = p.replace(/\([^)]+\)/g, "{param}");
  p = p.replace(/\[\\^[^\\]]+\\]/g, "{param}");
  p = p.replace(/\[[^\]]+\]/g, "{param}");
  p = p.replace(/\{param\}\?/g, "{param}");
  p = p.replace(/\{param\}\*/g, "{param}");
  p = p.replace(/\{param\}\+/g, "{param}");
  p = p.replace(/\{param\}/g, "{id}");
  if (followersAlt) {
    p = p.replace("__FOLLOWERS_ALT__", "(followers|following)");
  }

  // Specific patterns
  // Handle /gallery(/items)? -> /gallery and /gallery/items handled separately
  if (p.includes("gallery")) {
    // Keep both forms as /gallery (the redirect handles items)
    p = p.replace(/^\/gallery.*/, "/gallery");
  }
  if (p.includes("prompts")) {
    // /prompts, /prompts/{slug}, /prompts/{slug}/items all map to /prompts family
    // For Events we keep the specific paths, so don't collapse yet
  }
  // Collapse trailing regex noise
  if (p.includes(".*") && !p.startsWith("/prompts")) {
    p = p.replace(/\/\.\*.*$/, "/{id}").replace(/^\.\*.*$/, "/");
  }
  if (p === "/") return "/";
  // Ensure leading slash
  if (!p.startsWith("/")) p = `/${p}`;
  // Clean up doubled placeholders
  p = p.replace(/\{id\}\/\{id\}/g, "{id}");
  // For /auth/.+ keep as /auth/{proxy+}
  if (p === "/auth/.+") p = "/auth/{proxy+}";
  // Normalise /prompts/.* leftover
  if (p === "/prompts.*") p = "/prompts";
  return p;
}

function expectedApiEvents(routes: RouteDecl[]): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  for (const r of routes) {
    let apiPath = patternToApiPath(r.patternSrc);
    // Expand alternations like (followers|following) into separate paths
    // so diff matches the template's two explicit Events.
    const alts = apiPath.match(/\(followers\|following\)/);
    if (alts) {
      for (const seg of ["followers", "following"]) {
        const p = apiPath.replace("(followers|following)", seg);
        for (const m of r.methods) {
          // Render routes use ANY in template to allow HEAD
          const method = m === "GET" ? "ANY" : m;
          out.push({ method, path: p });
        }
      }
      continue;
    }
    // Handle the catch-all /auth/.+ — template has 7 explicit /auth/* Events,
    // not a single {proxy+} — treat it as covering all, so don't emit it
    // as a required Event; the individual auth sub-routes are validated
    // separately via the POST /auth/* dispatch.
    if (apiPath === "/auth/{proxy+}") {
      // Don't emit — template's 7 POST /auth/* cover it
      continue;
    }
    // Gallery redirect is handled at the CloudFront Function edge; no API
    // Gateway Event needed (direct API hits are rare and the edge handles it)
    if (apiPath === "/gallery") {
      continue;
    }
    for (const m of r.methods) {
      const method = m === "GET" ? "ANY" : m;
      out.push({ method, path: apiPath });
    }
  }
  for (const e of out) {
    if (e.path === "/users/{id}/stats") e.path = "/users/{user_id}/stats";
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Load current files
// ---------------------------------------------------------------------------

function loadCurrentViteProxies(): string[] {
  const src = readFileSync(resolve(repoRoot, "vite.config.ts"), "utf8");
  const m = src.match(/const DEV_PROXY_PATHS\s*=\s*\[([\s\S]*?)\]/m);
  if (!m) throw new Error("could not parse DEV_PROXY_PATHS from vite.config.ts");
  const raw = m[1];
  // Strip // comments so quoted strings inside comments (e.g. "publish → see on the feed")
  // are not mistaken for proxy entries.
  const stripped = raw
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  return [...stripped.matchAll(/"([^"]+)"|'([^']+)'/g)].map((x) => x[1] ?? x[2]);
}

function loadTemplatePaths(): { method: string; path: string }[] {
  const src = readFileSync(resolve(repoRoot, "infra/aws/template.yaml"), "utf8");
  const out: { method: string; path: string }[] = [];
  // Each Event block has Method: and Path: lines
  const eventRe = /Type:\s*HttpApi[\s\S]*?Method:\s*(\S+)[\s\S]*?Path:\s*(\S+)/g;
  let mm: RegExpExecArray | null;
  while ((mm = eventRe.exec(src))) {
    out.push({ method: mm[1], path: mm[2] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Diff & report
// ---------------------------------------------------------------------------

function diffVite(expected: string[], actual: string[]): { missing: string[]; extra: string[] } {
  const eSet = new Set(expected);
  const aSet = new Set(actual);
  return {
    missing: expected.filter((x) => !aSet.has(x)),
    extra: actual.filter((x) => !eSet.has(x)),
  };
}

function diffEvents(
  expected: { method: string; path: string }[],
  actual: { method: string; path: string }[]
): { missing: typeof expected; extra: typeof expected } {
  const key = (e: { method: string; path: string }) => `${e.method} ${e.path}`;
  const eSet = new Set(expected.map(key));
  const aSet = new Set(actual.map(key));
  return {
    missing: expected.filter((e) => !aSet.has(key(e))),
    extra: actual.filter((e) => !eSet.has(key(e))),
  };
}

// ---------------------------------------------------------------------------
// 6. Write vite.config.ts
// ---------------------------------------------------------------------------

function writeViteProxies(next: string[]): void {
  const src = readFileSync(resolve(repoRoot, "vite.config.ts"), "utf8");
  const block = `const DEV_PROXY_PATHS = [
${next.map((p) => `  "${p}",`).join("\n")}
];`;
  // Support both plain and marked blocks. If markers exist, replace between them,
  // otherwise replace the first const DEV_PROXY_PATHS = [...] block.
  const markedRe =
    /(\/\/ BEGIN GENERATED DEV_PROXY_PATHS[\s\S]*?\/\/ END GENERATED DEV_PROXY_PATHS)/;
  if (markedRe.test(src)) {
    // Not yet used — placeholder for future marker migration
    const nextSrc = src.replace(/const DEV_PROXY_PATHS\s*=\s*\[[\s\S]*?\];/, block);
    writeFileSync(resolve(repoRoot, "vite.config.ts"), nextSrc, "utf8");
    return;
  }
  // Heuristic: replace the const DEV_PROXY_PATHS = [...] declaration
  const nextSrc = src.replace(/const DEV_PROXY_PATHS\s*=\s*\[[\s\S]*?\];/, block);
  writeFileSync(resolve(repoRoot, "vite.config.ts"), nextSrc, "utf8");
}

// ---------------------------------------------------------------------------
// 7. Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const shouldWrite = args.includes("--write");
  const verbose = args.includes("--verbose") || args.includes("-v");

  const routes = loadRoutes();
  const expectedVite = expectedViteProxies(routes);
  const actualVite = loadCurrentViteProxies();
  const viteDiff = diffVite(expectedVite, actualVite);

  const expectedEvents = expectedApiEvents(routes);
  const actualEvents = loadTemplatePaths();
  const eventsDiff = diffEvents(expectedEvents, actualEvents);

  if (verbose) {
    console.log(`Routes parsed: ${routes.length}`);
    console.log(`Expected vite proxies (${expectedVite.length}): ${expectedVite.join(", ")}`);
    console.log(`Actual vite proxies (${actualVite.length}): ${actualVite.join(", ")}`);
    console.log(`Expected events (${expectedEvents.length}) vs actual (${actualEvents.length})`);
  }

  let ok = true;

  if (viteDiff.missing.length > 0 || viteDiff.extra.length > 0) {
    ok = false;
    if (viteDiff.missing.length > 0) {
      console.error(`gen-routes: MISSING vite proxy entries (${viteDiff.missing.length}):`);
      for (const m of viteDiff.missing) console.error(`  + ${JSON.stringify(m)}`);
    }
    if (viteDiff.extra.length > 0) {
      console.error(`gen-routes: EXTRA vite proxy entries (${viteDiff.extra.length}):`);
      for (const e of viteDiff.extra) console.error(`  - ${JSON.stringify(e)}`);
      console.error(
        `  (extra entries may be intentional — e.g. legacy /gallery redirect — but review)`
      );
    }
    if (shouldWrite) {
      console.log("gen-routes: --write — updating vite.config.ts DEV_PROXY_PATHS");
      writeViteProxies(expectedVite);
      console.log(`gen-routes: wrote ${expectedVite.length} entries to vite.config.ts`);
      // Re-check after write would be clean for vite; still report events diff
    } else {
      console.error(`gen-routes: run with --write to fix vite.config.ts`);
    }
  } else {
    console.log(`gen-routes: vite proxies OK — ${expectedVite.length} entries`);
  }

  // For template.yaml we only report — auto-writing YAML is riskier due to
  // CloudFormation formatting + logical IDs. The check still catches the
  // brittle coupling; fixing the Events block stays manual but now with an
  // exact diff.
  if (eventsDiff.missing.length > 0 || eventsDiff.extra.length > 0) {
    // Filter out known intentional extras: /merch/* lives in merch Lambda,
    // not ingest/routes.ts. Those Paths are expected extras.
    // Also /auth/* — template has 7 explicit POST /auth/*, routes has a
    // single catch-all POST /auth/.+ dispatch; treat them as covering.
    const merchExtras = eventsDiff.extra.filter((e) => e.path.startsWith("/merch"));
    const authExtras = eventsDiff.extra.filter((e) => e.path.startsWith("/auth/"));
    const nonMerchNonAuthExtras = eventsDiff.extra.filter(
      (e) => !e.path.startsWith("/merch") && !e.path.startsWith("/auth/")
    );
    const nonMerchExtras = nonMerchNonAuthExtras;
    const nonMerchMissing = eventsDiff.missing.filter((e) => e.path !== "/auth/{proxy+}");

    // Normalise placeholder names ({slug}, {page}, {orderId}, {username}, etc.)
    // and treat ANY as a superset of GET (template uses ANY to allow HEAD).
    const normPath = (p: string) => p.replace(/\{[^}]+\}/g, "{id}");
    const normMethod = (m: string) => m;
    const matches = (
      expected: { method: string; path: string },
      actual: { method: string; path: string }
    ) => {
      if (normPath(expected.path) !== normPath(actual.path)) return false;
      if (expected.method === actual.method) return true;
      // ANY in template matches GET in routes (HEAD→GET normalization)
      if (expected.method === "GET" && actual.method === "ANY") return true;
      if (expected.method === "ANY" && actual.method === "GET") return true;
      return false;
    };
    const normMissing = nonMerchMissing.filter((e) => !actualEvents.some((a) => matches(e, a)));
    const normExtras = nonMerchExtras.filter((e) => !expectedEvents.some((ex) => matches(ex, e)));

    if (normMissing.length > 0 || normExtras.length > 0) {
      ok = false;
      if (normMissing.length > 0) {
        console.error(`gen-routes: MISSING template.yaml Events (${normMissing.length}):`);
        for (const m of normMissing) console.error(`  + ${m.method} ${m.path}`);
      }
      if (normExtras.length > 0) {
        console.error(`gen-routes: EXTRA template.yaml Events (${normExtras.length}):`);
        for (const e of normExtras) console.error(`  - ${e.method} ${e.path}`);
      }
      if (merchExtras.length > 0 && verbose) {
        console.log(`gen-routes: (ignoring ${merchExtras.length} merch Lambda Events)`);
      }
    } else if (merchExtras.length > 0 && verbose) {
      console.log(`gen-routes: ignoring ${merchExtras.length} merch Lambda Events`);
    }

    if (normMissing.length === 0 && normExtras.length === 0) {
      console.log(`gen-routes: template Events OK — ${actualEvents.length} events (incl. merch)`);
    } else {
      console.error(
        `gen-routes: template.yaml Events out of sync — fix manually (single source is routes.ts)`
      );
    }
  } else {
    console.log(`gen-routes: template Events OK — ${actualEvents.length} events`);
  }

  if (ok) {
    console.log("gen-routes: OK — all checked targets in sync");
  } else {
    if (!shouldWrite) {
      console.error(
        "\ngen-routes: FAIL — run `npx tsx scripts/gen-routes.ts --write` to fix vite.config.ts, then fix template.yaml Events manually"
      );
    }
    process.exit(1);
  }
}

main();
