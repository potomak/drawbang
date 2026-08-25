import type { RouteDeps } from "./routes.js";

/**
 * Mock `RouteDeps` that yields the maximal route table from `createRoutes()`.
 * Used by `scripts/validate-routes.ts` and the future `validate-proxy` — we
 * only care about `{methods, pattern}` pairs, not handler behavior, so all
 * stores are dummy objects and `userStatsStore` is present to include
 * `GET /users/{id}/stats`.
 *
 * Keep this in `ingest/` so both `scripts/` and `test/` can import it without
 * circular deps. If you add a new optional dep that gates a route, add it
 * here so the validator sees the maximal table.
 */
export function mockRouteDeps(): RouteDeps {
  const dummyStore = {} as unknown as never;
  const dummyFn = () => {};
  return {
    renderConfig: {
      drawingStore: dummyStore,
      publicBaseUrl: "https://example.com",
      repoUrl: "https://github.com/potomak/drawbang",
      userStatsStore: dummyStore,
      userStore: dummyStore,
      bookmarksStore: dummyStore,
      followsStore: dummyStore,
      productCountersSource: dummyStore,
      merchCatalog: { products: [] } as unknown as never,
    },
    likesConfig: dummyStore,
    bookmarksConfig: dummyStore,
    followsConfig: dummyStore,
    hydrateConfig: dummyStore,
    subscribeConfig: dummyStore,
    deleteConfig: {
      drawingStore: dummyStore,
      storage: dummyStore,
      cacheInvalidator: undefined as never,
    },
    backfillConfig: {
      drawingStore: dummyStore,
      storage: dummyStore,
      enqueue: dummyFn as never,
      runNow: dummyFn as never,
    },
    authConfig: {
      userStore: dummyStore,
      email: dummyStore,
      jwtSecret: "test-secret",
      publicBaseUrl: "https://example.com",
      drawingStore: dummyStore,
      storage: dummyStore,
      cacheInvalidator: undefined,
      challenge: { secret: "test", challengeStore: dummyStore },
    },
    ingestConfig: {
      storage: dummyStore,
      publicBaseUrl: "https://example.com",
      repoUrl: "https://example.com",
      drawingStore: dummyStore,
      cacheInvalidator: undefined,
      deferPostPublish: dummyFn as never,
    },
    userStatsStore: dummyStore,
    admin: {
      isAllowed: () => true,
      renderData: async () => ({
        status: 200,
        contentType: "text/html",
        cacheControl: "no-store",
        body: "",
      }),
    },
    repoUrl: "https://github.com/potomak/drawbang",
  };
}
