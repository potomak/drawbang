import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  DEFAULT_LIMIT,
  DEFAULT_SCAN_LIMIT,
  MAX_LIMIT,
  MAX_SCAN_LIMIT,
  handleBackfillSidecars,
  parseBackfillOptions,
  type BackfillOptions,
  type BackfillReport,
} from "../ingest/backfill-handler.js";
import { MemoryDrawingStore, type DrawingRow } from "../ingest/drawing-store.js";
import { FsStorage } from "../ingest/storage.js";
import type { PostPublishJob } from "../ingest/handler.js";
import { ANONYMOUS_USER_ID, ANONYMOUS_USERNAME } from "../config/constants.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ALICE = { user_id: "a".repeat(64), username: "alice" };
const BOB = { user_id: "b".repeat(64), username: "bob" };
const ADMIN = { user_id: "c".repeat(64), username: "root" };

function id(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function row(n: number, username = "alice"): DrawingRow {
  const ms = Date.parse("2026-05-01T12:00:00.000Z") + n * 1000;
  return {
    drawing_id: id(n),
    size: 16,
    created_at: new Date(ms).toISOString(),
    created_at_ms: ms,
    user_id: username === ALICE.username ? ALICE.user_id : BOB.user_id,
    username,
    parent_id: null,
    frames: 1,
    gif_size_bytes: 100,
  };
}

function opts(over: Partial<BackfillOptions> = {}): BackfillOptions {
  return {
    target: null,
    scope: "mine",
    limit: DEFAULT_LIMIT,
    scanLimit: DEFAULT_SCAN_LIMIT,
    dryRun: false,
    ...over,
  };
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "drawbang-bf-"));
  const storage = new FsStorage(dir);
  const drawingStore = new MemoryDrawingStore();
  const jobs: PostPublishJob[] = [];
  return {
    storage,
    drawingStore,
    jobs,
    cfg: {
      drawingStore,
      storage,
      enqueue: async (job: PostPublishJob) => { jobs.push(job); },
      isAdmin: (u: string) => u === ADMIN.username,
    },
    // Seeds a drawing plus whichever sidecars it should already have.
    seed: async (n: number, username: string, has: { gif?: boolean; mp4?: boolean }) => {
      await drawingStore.put(row(n, username));
      await storage.put(`public/tiles/${id(n)}.gif`, new Uint8Array([1]), "image/gif");
      if (has.gif) await storage.put(`public/tiles/${id(n)}-large.gif`, new Uint8Array([2]), "image/gif");
      if (has.mp4) await storage.put(`public/tiles/${id(n)}-large.mp4`, new Uint8Array([3]), "video/mp4");
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("parseBackfillOptions", () => {
  test("defaults are conservative", () => {
    const o = parseBackfillOptions({ drawing: null, scope: null, limit: null, scan: null, dry: null });
    assert.deepEqual(o, {
      target: null,
      scope: "mine",
      limit: DEFAULT_LIMIT,
      scanLimit: DEFAULT_SCAN_LIMIT,
      dryRun: false,
    });
  });

  test("scope only widens on an exact 'all'", () => {
    for (const v of ["ALL", "all ", "everything", "1", ""]) {
      assert.equal(
        parseBackfillOptions({ drawing: null, scope: v, limit: null, scan: null, dry: null }).scope,
        "mine",
        `scope=${JSON.stringify(v)} must not widen`,
      );
    }
    assert.equal(
      parseBackfillOptions({ drawing: null, scope: "all", limit: null, scan: null, dry: null }).scope,
      "all",
    );
  });

  test("limits are clamped, and garbage falls back to the default", () => {
    const big = parseBackfillOptions({ drawing: null, scope: null, limit: "99999", scan: "99999", dry: null });
    assert.equal(big.limit, MAX_LIMIT);
    assert.equal(big.scanLimit, MAX_SCAN_LIMIT);
    const small = parseBackfillOptions({ drawing: null, scope: null, limit: "0", scan: "-5", dry: null });
    assert.equal(small.limit, 1);
    assert.equal(small.scanLimit, 1);
    const junk = parseBackfillOptions({ drawing: null, scope: null, limit: "abc", scan: "", dry: null });
    assert.equal(junk.limit, DEFAULT_LIMIT);
    assert.equal(junk.scanLimit, DEFAULT_SCAN_LIMIT);
  });

  test("dry-run resolves ambiguity toward doing nothing", () => {
    for (const v of ["1", "true", "yes", "whatever"]) {
      assert.equal(parseBackfillOptions({ drawing: null, scope: null, limit: null, scan: null, dry: v }).dryRun, true, v);
    }
    for (const v of [null, "", "0", "false"]) {
      assert.equal(parseBackfillOptions({ drawing: null, scope: null, limit: null, scan: null, dry: v }).dryRun, false, String(v));
    }
  });
});

describe("handleBackfillSidecars — scope is the security boundary", () => {
  test("scope=all is refused for a non-operator, and nothing is enqueued", async () => {
    const h = await harness();
    try {
      await h.seed(1, "alice", {});
      const res = await handleBackfillSidecars(opts({ scope: "all" }), ALICE, h.cfg);
      assert.equal(res.status, 403);
      assert.deepEqual(h.jobs, []);
    } finally {
      await h.cleanup();
    }
  });

  test("scope=all is allowed for an operator", async () => {
    const h = await harness();
    try {
      await h.seed(1, "alice", {});
      const res = await handleBackfillSidecars(opts({ scope: "all" }), ADMIN, h.cfg);
      assert.equal(res.status, 200);
      assert.deepEqual(h.jobs.map((j) => j.drawing_id), [id(1)]);
    } finally {
      await h.cleanup();
    }
  });

  test("the default scope never reaches another user's drawings", async () => {
    const h = await harness();
    try {
      await h.seed(1, "alice", {});
      await h.seed(2, "bob", {});
      const res = await handleBackfillSidecars(opts(), ALICE, h.cfg);
      assert.equal(res.status, 200);
      assert.deepEqual(h.jobs.map((j) => j.drawing_id), [id(1)], "only alice's drawing");
      assert.equal((res.body as BackfillReport).scanned, 1);
    } finally {
      await h.cleanup();
    }
  });

  test("anonymous drawings are reachable only via scope=all", async () => {
    const h = await harness();
    try {
      await h.seed(1, ANONYMOUS_USERNAME, {});
      // Nobody can hold the sentinel handle, but if a token claimed it the
      // owner-scoped path must still refuse.
      const asSentinel = { user_id: ANONYMOUS_USER_ID, username: ANONYMOUS_USERNAME };
      assert.equal((await handleBackfillSidecars(opts(), asSentinel, h.cfg)).status, 403);
      assert.equal(h.jobs.length, 0);
      const res = await handleBackfillSidecars(opts({ scope: "all" }), ADMIN, h.cfg);
      assert.equal(res.status, 200);
      assert.equal(h.jobs[0].username, null, "sentinel maps to a null username");
    } finally {
      await h.cleanup();
    }
  });
});

describe("handleBackfillSidecars — targeted single drawing", () => {
  test("any signed-in caller can repair one drawing they don't own", async () => {
    // Safe because it only creates derived data that should already
    // exist, is idempotent, and is strictly less powerful than
    // publishing — which anonymous callers can already do.
    const h = await harness();
    try {
      await h.seed(1, "alice", {});
      const res = await handleBackfillSidecars(opts({ target: id(1) }), BOB, h.cfg);
      assert.equal(res.status, 200);
      const body = res.body as BackfillReport;
      assert.equal(body.scope, "one");
      assert.deepEqual(body.enqueued, [id(1)]);
      assert.deepEqual(h.jobs, [
        { drawing_id: id(1), username: "alice", prompt_tagged: false, mode: "backfill" },
      ]);
    } finally {
      await h.cleanup();
    }
  });

  test("a healthy drawing produces no work at all", async () => {
    const h = await harness();
    try {
      await h.seed(1, "alice", { gif: true, mp4: true });
      const res = await handleBackfillSidecars(opts({ target: id(1) }), BOB, h.cfg);
      const body = res.body as BackfillReport;
      assert.deepEqual(body.missing, []);
      assert.deepEqual(body.enqueued, []);
      assert.equal(h.jobs.length, 0, "idempotent — repeat calls cost nothing");
    } finally {
      await h.cleanup();
    }
  });

  test("it is bounded to exactly one job regardless of what else is broken", async () => {
    const h = await harness();
    try {
      for (let n = 1; n <= 5; n++) await h.seed(n, "alice", {});
      await handleBackfillSidecars(opts({ target: id(3) }), BOB, h.cfg);
      assert.deepEqual(h.jobs.map((j) => j.drawing_id), [id(3)], "only the named drawing");
    } finally {
      await h.cleanup();
    }
  });

  test("an unknown drawing is a 404, not a silent success", async () => {
    const h = await harness();
    try {
      const res = await handleBackfillSidecars(opts({ target: id(99) }), BOB, h.cfg);
      assert.equal(res.status, 404);
      assert.equal(h.jobs.length, 0);
    } finally {
      await h.cleanup();
    }
  });

  test("a malformed id is ignored, falling back to the owner-scoped scan", async () => {
    // parseBackfillOptions only accepts a well-formed 64-hex id, so a junk
    // value must not become a target — and must not widen anything either.
    const o = parseBackfillOptions({ drawing: "not-an-id", scope: null, limit: null, scan: null, dry: null });
    assert.equal(o.target, null);
    assert.equal(o.scope, "mine");
  });

  test("targeting an anonymous drawing still passes a null username to the job", async () => {
    const h = await harness();
    try {
      await h.seed(1, ANONYMOUS_USERNAME, {});
      await handleBackfillSidecars(opts({ target: id(1) }), BOB, h.cfg);
      assert.equal(h.jobs[0].username, null);
    } finally {
      await h.cleanup();
    }
  });

  test("dry run on a target reports but enqueues nothing", async () => {
    const h = await harness();
    try {
      await h.seed(1, "alice", {});
      const res = await handleBackfillSidecars(opts({ target: id(1), dryRun: true }), BOB, h.cfg);
      assert.deepEqual((res.body as BackfillReport).enqueued, [id(1)]);
      assert.equal(h.jobs.length, 0);
    } finally {
      await h.cleanup();
    }
  });
});

describe("handleBackfillSidecars — what it repairs", () => {
  test("skips drawings that already have both sidecars", async () => {
    const h = await harness();
    try {
      await h.seed(1, "alice", { gif: true, mp4: true });
      const res = await handleBackfillSidecars(opts(), ALICE, h.cfg);
      const body = res.body as BackfillReport;
      assert.equal(body.scanned, 1);
      assert.deepEqual(body.missing, []);
      assert.deepEqual(h.jobs, []);
    } finally {
      await h.cleanup();
    }
  });

  test("reports exactly which sidecar is missing", async () => {
    const h = await harness();
    try {
      await h.seed(1, "alice", { gif: true });          // mp4 missing
      await h.seed(2, "alice", { mp4: true });          // gif missing
      await h.seed(3, "alice", {});                     // both missing
      await h.seed(4, "alice", { gif: true, mp4: true }); // fine
      const res = await handleBackfillSidecars(opts(), ALICE, h.cfg);
      const body = res.body as BackfillReport;
      const byId = new Map(body.missing.map((m) => [m.drawing_id, m.needs]));
      assert.deepEqual(byId.get(id(1)), ["-large.mp4"]);
      assert.deepEqual(byId.get(id(2)), ["-large.gif"]);
      assert.deepEqual(byId.get(id(3)), ["-large.gif", "-large.mp4"]);
      assert.equal(byId.has(id(4)), false);
      assert.equal(body.scanned, 4);
    } finally {
      await h.cleanup();
    }
  });

  test("enqueues backfill-mode jobs so only the tile paths get flushed", async () => {
    const h = await harness();
    try {
      await h.seed(1, "alice", {});
      await handleBackfillSidecars(opts(), ALICE, h.cfg);
      assert.deepEqual(h.jobs, [
        { drawing_id: id(1), username: "alice", prompt_tagged: false, mode: "backfill" },
      ]);
    } finally {
      await h.cleanup();
    }
  });

  test("a dry run reports the same findings but enqueues nothing", async () => {
    const h = await harness();
    try {
      await h.seed(1, "alice", {});
      await h.seed(2, "alice", {});
      const res = await handleBackfillSidecars(opts({ dryRun: true }), ALICE, h.cfg);
      const body = res.body as BackfillReport;
      assert.equal(body.dry_run, true);
      assert.equal(body.missing.length, 2);
      assert.deepEqual(body.enqueued, [id(2), id(1)], "still reports what it would do");
      assert.deepEqual(h.jobs, [], "but nothing is actually queued");
    } finally {
      await h.cleanup();
    }
  });

  test("limit caps the fan-out while still reporting everything found", async () => {
    const h = await harness();
    try {
      for (let n = 1; n <= 5; n++) await h.seed(n, "alice", {});
      const res = await handleBackfillSidecars(opts({ limit: 2 }), ALICE, h.cfg);
      const body = res.body as BackfillReport;
      assert.equal(body.missing.length, 5, "reports all five");
      assert.equal(body.enqueued.length, 2, "but only queues two");
      assert.equal(h.jobs.length, 2);
    } finally {
      await h.cleanup();
    }
  });

  test("scanLimit bounds the work and flags that there may be more", async () => {
    const h = await harness();
    try {
      for (let n = 1; n <= 6; n++) await h.seed(n, "alice", {});
      const res = await handleBackfillSidecars(opts({ scanLimit: 3 }), ALICE, h.cfg);
      const body = res.body as BackfillReport;
      assert.equal(body.scanned, 3);
      assert.equal(body.truncated, true, "caller should run again");
    } finally {
      await h.cleanup();
    }
  });

  test("a complete scan is not flagged as truncated", async () => {
    const h = await harness();
    try {
      await h.seed(1, "alice", {});
      const res = await handleBackfillSidecars(opts(), ALICE, h.cfg);
      assert.equal((res.body as BackfillReport).truncated, false);
    } finally {
      await h.cleanup();
    }
  });

  test("an account with no drawings is a clean no-op", async () => {
    const h = await harness();
    try {
      const res = await handleBackfillSidecars(opts(), BOB, h.cfg);
      const body = res.body as BackfillReport;
      assert.equal(body.scanned, 0);
      assert.deepEqual(body.missing, []);
      assert.deepEqual(body.enqueued, []);
    } finally {
      await h.cleanup();
    }
  });
});
