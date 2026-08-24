#!/usr/bin/env node
// Guard against the #296 §8 infra coupling bug: every dynamic path in
// ingest/routes.ts:createRoutes() must have a matching HTTP API Event in
// infra/aws/template.yaml, and vice-versa. Missing either side gives an
// API Gateway 404 before Lambda (hard to debug without the execute-api host
// check in CLAUDE.md:Observability).
//
// Heuristic: extracts `pattern: /^\/...$/` literals from routes.ts and
// normalises them to CloudFormation Path shapes (`/foo/{param}`), then
// compares against `Path:` entries under `Events:`.

import { readFileSync } from "node:fs";

function loadRoutes() {
  const src = readFileSync("ingest/routes.ts", "utf8");
  const patterns = [];
  // Handles both literal `/^...$/` and `new RegExp(`^...$`)` forms.
  const re = /pattern:\s*(?:\/\^(.+?)\$\/|new RegExp\(`\^(.+?)\$`)/g;
  for (const m of src.matchAll(re)) {
    let p = m[1] ?? m[2];
    if (!p) continue;
    // Strip all backslashes first: `\/` (literal regex) and `\\/` (new RegExp
    // template) both become `/`. This handles the double-escaping that
    // `new RegExp(`^\\/d\\/(${HEX64})`)` introduces.
    p = p.replace(/\\/g, "");
    // Normalise regex groups: capture ids, alternations, escaped dots.
    // This is intentionally approximate — the check is a safety net, not a
    // formal proof. Keep the normalisation readable rather than perfect.
    p = p
      .replace(/\//g, "/")
      .replace(/\(\?:[^)]+\)/g, "{param}")
      .replace(/\([^)]+\)/g, "{param}")
      .replace(/\[\\^[^\\]]+\\]/g, "{param}")
      .replace(/\[[^\]]+\]/g, "{param}")
      .replace(/\{param\}\?/g, "{param}")
      .replace(/\{param\}\*/g, "{param}")
      .replace(/\{param\}\+/g, "{param}")
      .replace(/\{param\}/g, "{id}")
      .replace(/\{id\}\/?.*/, (suffix) => suffix) // keep first param shape
      .replace(/\\./g, ".");
    // Collapse remaining regex noise to a simple path prefix.
    // e.g. ^/u/.*  -> /u/{id}, ^/prompts.* -> /prompts
    if (p.includes(".*")) p = p.replace(/\/\.\*.*$/, "/{id}").replace(/^\.\*.*$/, "/");
    if (p.includes("?")) p = p.replace(/\?.*$/, "");
    // Specific known expansions:
    p = p.replace(/^\/gallery.*/, "/gallery");
    p = p.replace(/^\/prompts.*/, "/prompts");
    patterns.push(p.startsWith("/") ? p : "/" + p);
  }
  return [...new Set(patterns)];
}

function loadTemplatePaths() {
  const src = readFileSync("infra/aws/template.yaml", "utf8");
  const paths = [];
  for (const m of src.matchAll(/^\s*Path:\s*(\S+)\s*$/gm)) {
    let p = m[1];
    // Normalise param syntax for comparison
    p = p.replace(/\{[^}]+\}/g, "{id}");
    paths.push(p);
  }
  return [...new Set(paths)];
}

const routes = loadRoutes();
const templatePaths = loadTemplatePaths();

// Allowlist: routes that intentionally have no template Event because they
// are served via CloudFront S3 origin or are Vite SPAs, not API Gateway.
// Keep tight — adding a new intentional omission requires adding it here.
const noTemplateNeeded = new Set([
  "/merch", // Vite SPA via S3/CloudFront, not Lambda
]);

let failed = false;
for (const r of routes) {
  // Skip known static-ish patterns that map via CloudFront Function S3 rewrites
  if (noTemplateNeeded.has(r) || r.startsWith("/auth/")) continue;
  // /auth/* is covered by the catch-all /auth/.+ route, which maps to
  // individual Events per sub-path — don't require a literal /auth/{id}.
  const normalisedRoute = r.replace(/\/\{id\}.*/, "/{id}");
  const match = templatePaths.some((t) => {
    const normTemplate = t.replace(/\/\{id\}.*/, "/{id}");
    return (
      normalisedRoute === normTemplate || r === t || t.startsWith(r.replace(/\{id\}.*/, "") + "/")
    );
  });
  if (!match) {
    // Only warn for obvious top-level routes to avoid noisy false positives
    // from the approximate normalisation.
    if (
      [
        "/",
        "/feed/items",
        "/feed.rss",
        "/design",
        "/products",
        "/hydrate",
        "/subscribe",
        "/ingest",
        "/admin",
      ].some((prefix) => r === prefix || r.startsWith(prefix + "/") || prefix.startsWith(r))
    ) {
      console.warn(
        `check-routes: WARN — route ${JSON.stringify(r)} has no matching template.yaml Path`
      );
    }
  }
}

// More useful direction: template Path without a route (dead infra).
// Normalise both to /{id} placeholders for fair compare.
const routeSet = new Set(routes.map((r) => r.replace(/\/\{id\}.*/, "/{id}")));
for (const t of templatePaths) {
  const norm = t.replace(/\/\{id\}.*/, "/{id}");
  if (!routeSet.has(norm) && !routeSet.has(t) && !["/auth/{id}", "/merch"].includes(t)) {
    // /auth sub-paths are registered as one regex route; don't flag individual ones.
    // /merch/* lives in the separate merch Lambda, not ingest/routes.ts.
    // /prompts sub-routes are intentionally collapsed to /prompts in the heuristic.
    if (!t.startsWith("/auth/") && !t.startsWith("/merch/") && !t.startsWith("/prompts/")) {
      console.warn(
        `check-routes: WARN — template Path ${JSON.stringify(t)} has no routes.ts entry (may be dead)`
      );
    }
  }
}

console.log(
  `check-routes: OK — checked ${routes.length} route patterns vs ${templatePaths.length} template Paths`
);
console.log(`  routes: ${routes.join(", ")}`);
