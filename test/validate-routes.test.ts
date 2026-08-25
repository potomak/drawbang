import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Regression test for routes validation (PR #300 / #298 proposal 3).
// ingest/routes.ts is the single source of truth — vite.config.ts
// DEV_PROXY_PATHS is manual (see routes.ts comment) and
// infra/aws/template.yaml Events is validated via createRoutes() with
// mock deps (scripts/validate-routes.ts). This test pins the vite list
// and ensures the validator stays green.

function loadViteProxies(): string[] {
  const src = readFileSync("vite.config.ts", "utf8");
  const m = src.match(/const DEV_PROXY_PATHS\s*=\s*\[([\s\S]*?)\]/m);
  assert.ok(m, "could not parse DEV_PROXY_PATHS from vite.config.ts");
  const raw = m[1];
  const stripped = raw
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  return [...stripped.matchAll(/"([^"]+)"|'([^']+)'/g)].map((x) => x[1] ?? x[2]);
}

describe("validate-routes", () => {
  test("vite DEV_PROXY_PATHS is exactly the 19-entry manual list", () => {
    const proxies = loadViteProxies();
    // Snapshot of the manual list — update vite.config.ts and this snapshot
    // together when adding a route (see ingest/routes.ts comment).
    const expected = [
      "^/$",
      "/admin",
      "/auth",
      "/backfill",
      "/design",
      "/drawings",
      "/feed.rss",
      "/feed/items",
      "/hydrate",
      "/ingest",
      "/me",
      "/subscribe",
      "/users",
      "^/d/.*",
      "^/embed/.*",
      "^/gallery(/items)?$",
      "^/products.*",
      "^/prompts.*",
      "^/u/.*",
    ];
    assert.deepEqual(proxies, expected);
  });

  test("vite proxies do not shadow src/** imports (like check-proxy)", () => {
    const proxies = loadViteProxies();
    const protectedImports = [
      "/merch/placement.ts",
      "/merch/catalog.ts",
      "/merch/printify.ts",
      "/src/merch-preview.ts",
      "/src/merch.ts",
    ];
    function matchesProxy(url: string, pattern: string): boolean {
      if (pattern.startsWith("^")) {
        try {
          return new RegExp(pattern).test(url);
        } catch {
          return false;
        }
      }
      return url === pattern || url.startsWith(pattern + "/");
    }
    for (const url of protectedImports) {
      for (const p of proxies) {
        assert.equal(
          matchesProxy(url, p),
          false,
          `proxy pattern ${JSON.stringify(p)} must not match protected import ${url}`
        );
      }
    }
  });

  test("validate-routes passes (template in sync via createRoutes)", () => {
    const res = spawnSync(
      process.execPath,
      ["./node_modules/.bin/tsx", "scripts/validate-routes.ts"],
      {
        encoding: "utf8",
      }
    );
    assert.equal(
      res.status,
      0,
      `validate-routes should pass, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
    );
    assert.match(res.stdout, /OK/);
  });

  test("vite proxies include families needed for dev parity", () => {
    const proxies = loadViteProxies();
    // These families were missing before the codegen and broke dev (404 on :5173 but 200 on :8787)
    for (const needed of ["/hydrate", "/me", "/users", "/drawings", "^/products.*", "/design"]) {
      assert.ok(proxies.includes(needed), `expected vite proxy to include ${needed}`);
    }
    // /backfill is intentionally kept (dev-only, not prod CloudFront) — see discussion on PR #300.
    // Keeping it simplifies the codegen (one entry per route family, no allowlist).
    assert.ok(proxies.includes("/backfill"), "expected vite proxy to include /backfill (dev-only)");
  });

  test("legacy vite entries are gone", () => {
    const proxies = loadViteProxies();
    assert.equal(proxies.includes("/me/likes"), false, "/me/likes was replaced by /me");
    assert.equal(proxies.includes("/likes/counts"), false, "/likes/counts was dead");
    assert.equal(
      proxies.includes("^/drawings/.*/like$"),
      false,
      "narrow like regex was replaced by /drawings prefix"
    );
  });
});
