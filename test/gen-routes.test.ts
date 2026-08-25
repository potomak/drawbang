import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Regression test for scripts/gen-routes.ts (PR #300 / #298 proposal 3).
// The codegen makes ingest/routes.ts the single source of truth for
// vite.config.ts DEV_PROXY_PATHS and infra/aws/template.yaml Events.
// This test pins the generated output so a future route addition that
// forgets to run the codegen (or a broken pattern→proxy mapping) fails
// fast in CI, not as a 404 in dev/prod.

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

describe("gen-routes codegen", () => {
  test("vite DEV_PROXY_PATHS is exactly the generated 19-entry list", () => {
    const proxies = loadViteProxies();
    // Snapshot of the generated list — update via `npx tsx scripts/gen-routes.ts --write`
    // and commit both vite.config.ts and this snapshot together.
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

  test("gen-routes --check passes (vite + template in sync with routes.ts)", () => {
    const res = spawnSync(process.execPath, ["./node_modules/.bin/tsx", "scripts/gen-routes.ts"], {
      encoding: "utf8",
    });
    assert.equal(
      res.status,
      0,
      `gen-routes --check should pass, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
    );
    assert.match(res.stdout, /vite proxies OK/);
    assert.match(res.stdout, /template Events OK/);
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
