#!/usr/bin/env node
// Guard against the #296 §2 regression: DEV_PROXY_PATHS must never match
// src/** module imports (e.g. /merch/placement.ts) or Vite will 404 them
// before they reach the browser. Run in CI via `npm run lint` or directly:
//   node scripts/check-proxy.js

import { readFileSync } from "node:fs";

const viteConfig = readFileSync("vite.config.ts", "utf8");
const match = viteConfig.match(/const DEV_PROXY_PATHS\s*=\s*\[([\s\S]*?)\]/m);
if (!match) {
  console.error("check-proxy: could not parse DEV_PROXY_PATHS from vite.config.ts");
  process.exit(1);
}
const rawEntries = match[1];

// Extract string literals, both quoted and unquoted regex-style.
const entries = [...rawEntries.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]);

// Imports that MUST NOT be proxied. Add more if src gains sub-paths that
// collide with a proxy prefix (e.g. /auth/* vs /auth.ts).
const protectedImports = [
  "/merch/placement.ts",
  "/merch/catalog.ts",
  "/merch/printify.ts",
  "/src/merch-preview.ts",
  "/src/merch.ts",
];

function matchesProxy(url, pattern) {
  if (pattern.startsWith("^")) {
    try {
      return new RegExp(pattern).test(url);
    } catch {
      return false;
    }
  }
  // vite prefix match: pattern matches if url === pattern or url starts with pattern + "/"
  return url === pattern || url.startsWith(pattern + "/");
}

let failed = false;
for (const url of protectedImports) {
  for (const p of entries) {
    if (matchesProxy(url, p)) {
      console.error(
        `check-proxy: FAIL — proxy pattern ${JSON.stringify(p)} matches ${url} (would 404 the module)`
      );
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("check-proxy: OK — no DEV_PROXY_PATHS entry shadows a src/** import");
