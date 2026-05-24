import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { contentHash, hashHex, powHash, solve } from "../src/pow.js";
import { FsStorage } from "../ingest/storage.js";
import { build } from "../builder/build.js";

interface SeedOpts {
  user_id?: string;
  username?: string;
}

async function seedDrawing(
  root: string,
  day: string,
  marker: number,
  seedOpts: SeedOpts = {},
): Promise<string> {
  const frame = new Bitmap();
  // Unique pixel per caller so each gif hashes to a different ID (otherwise
  // content-addressing would collapse them into a single drawing).
  frame.set(marker % 16, Math.floor(marker / 16) % 16, ((marker % 15) + 1));
  const gif = encodeGif({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });
  const baseline = "1970-01-01T00:00:00.000Z";
  const sol = await solve(gif, baseline, 12); // cheap for tests
  const id = hashHex(await contentHash(gif));
  const pow = hashHex(await powHash(gif, baseline, sol.nonce));

  const gifPath = path.join(root, "inbox", day, `${id}.gif`);
  const jsonPath = path.join(root, "inbox", day, `${id}.json`);
  await fs.mkdir(path.dirname(gifPath), { recursive: true });
  await fs.writeFile(gifPath, gif);
  // Sidecar shape mirrors what ingest/handler.ts writes. When seedOpts has
  // user_id/username, include them; otherwise leave them out to model legacy
  // (account-less) inbox JSONs.
  const sidecar: Record<string, unknown> = {
    id,
    pow,
    nonce: sol.nonce,
    baseline,
    solve_ms: sol.solveMs,
    bench_hps: 12345,
    required_bits: 12,
    created_at: `${day}T10:00:00.000Z`,
    parent: null,
  };
  if (seedOpts.user_id !== undefined) sidecar.user_id = seedOpts.user_id;
  if (seedOpts.username !== undefined) sidecar.username = seedOpts.username;
  await fs.writeFile(jsonPath, JSON.stringify(sidecar));
  return id;
}

test("builder sweeps inbox, renders per-day pages, is incremental", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);

  // Seed three drawings on 2026-04-17.
  const ids = await Promise.all([
    seedDrawing(root, "2026-04-17", 1),
    seedDrawing(root, "2026-04-17", 2),
    seedDrawing(root, "2026-04-17", 3),
  ]);

  const first = await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-18" });
  assert.equal(first.sweptDrawings, 3);
  assert.ok(first.touchedDays.includes("2026-04-17"));

  for (const id of ids) {
    assert.ok(
      await fs.stat(path.join(root, `public/drawings/${id}.gif`)),
      `published gif for ${id}`,
    );
    assert.ok(await fs.stat(path.join(root, `public/d/${id}.html`)));
  }
  const dayPage = await fs.readFile(path.join(root, "public/days/2026-04-17/p/1.html"), "utf8");
  assert.ok(dayPage.includes("Draw!"));
  const indexHtml = await fs.readFile(path.join(root, "public/gallery.html"), "utf8");
  assert.ok(indexHtml.includes("2026-04-17"));

  // Capture mtimes before running again.
  const snapshot = new Map<string, number>();
  for (const rel of [
    "public/days/2026-04-17/p/1.html",
    "public/days/2026-04-17/manifest.json",
    "public/days/2026-04-17/index.jsonl",
    "public/gallery.html",
    "public/feed.rss",
  ]) {
    const stat = await fs.stat(path.join(root, rel));
    snapshot.set(rel, stat.mtimeMs);
  }
  // A small delay so any file we *do* rewrite gets a newer mtime.
  await new Promise((r) => setTimeout(r, 25));

  // Run again with an empty inbox.
  const second = await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-18" });
  assert.equal(second.sweptDrawings, 0);

  for (const rel of ["public/days/2026-04-17/p/1.html", "public/days/2026-04-17/index.jsonl", "public/days/2026-04-17/manifest.json"]) {
    const stat = await fs.stat(path.join(root, rel));
    assert.equal(stat.mtimeMs, snapshot.get(rel), `${rel} must not be rewritten`);
  }
  const indexStat = await fs.stat(path.join(root, "public/gallery.html"));
  assert.ok(indexStat.mtimeMs >= snapshot.get("public/gallery.html")!, "index.html is rolling");
});

interface IndexLine {
  id: string;
  user_id: string | null;
  username: string | null;
}

test("builder propagates user_id + username from inbox to per-day index.jsonl, drawing page renders profile link", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);

  const user_id = "a".repeat(64);
  const username = "alice";
  const id = await seedDrawing(root, "2026-04-19", 11, { user_id, username });

  await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-20" });

  const jsonl = await fs.readFile(
    path.join(root, "public/days/2026-04-19/index.jsonl"),
    "utf8",
  );
  const lines = jsonl.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]) as IndexLine;
  assert.equal(entry.id, id);
  assert.equal(entry.user_id, user_id);
  assert.equal(entry.username, username);

  // Per-drawing HTML carries an author link to /u/<username>.
  const drawingHtml = await fs.readFile(path.join(root, `public/d/${id}.html`), "utf8");
  assert.match(drawingHtml, new RegExp(`<dt>Author</dt><dd><a href="/u/${username}">`));
  // No "anonymous" fallback when the author is set.
  assert.equal(drawingHtml.includes("anonymous"), false);
});

test("builder per-account sweep: maintains u/<name>/index.jsonl and renders u/<name>.html", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);
  const user_id = "c".repeat(64);
  const username = "carol";

  // Two drawings on the same day, same account.
  const id1 = await seedDrawing(root, "2026-04-19", 21, { user_id, username });
  const id2 = await seedDrawing(root, "2026-04-19", 22, { user_id, username });

  await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-20" });

  const profileIndex = await fs.readFile(
    path.join(root, `public/u/${username}/index.jsonl`),
    "utf8",
  );
  const lines = profileIndex.split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  const ids = lines.map((l) => (JSON.parse(l) as { id: string }).id).sort();
  assert.deepEqual(ids, [id1, id2].sort());

  const profileHtml = await fs.readFile(path.join(root, `public/u/${username}.html`), "utf8");
  assert.match(profileHtml, /carol/);
  // Both drawings linked by their share URL.
  assert.match(profileHtml, new RegExp(`/d/${id1}`));
  assert.match(profileHtml, new RegExp(`/d/${id2}`));
  // Title + count badge surface the handle + drawing tally.
  assert.match(profileHtml, /Drawings by/);
  assert.match(profileHtml, /2 drawings/);
});

test("builder per-account sweep: separates two distinct accounts on the same day", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);

  const aliceId = await seedDrawing(root, "2026-04-19", 31, { user_id: "a".repeat(64), username: "alice" });
  const bobId = await seedDrawing(root, "2026-04-19", 32, { user_id: "b".repeat(64), username: "bob" });

  await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-20" });

  const aliceIdx = await fs.readFile(
    path.join(root, `public/u/alice/index.jsonl`),
    "utf8",
  );
  const bobIdx = await fs.readFile(
    path.join(root, `public/u/bob/index.jsonl`),
    "utf8",
  );
  assert.equal(aliceIdx.split("\n").filter(Boolean).length, 1);
  assert.equal(bobIdx.split("\n").filter(Boolean).length, 1);

  const aliceHtml = await fs.readFile(path.join(root, `public/u/alice.html`), "utf8");
  const bobHtml = await fs.readFile(path.join(root, `public/u/bob.html`), "utf8");
  // Each profile page links its own drawing only.
  assert.match(aliceHtml, new RegExp(`/d/${aliceId}`));
  assert.equal(aliceHtml.includes(bobId), false);
  assert.match(bobHtml, new RegExp(`/d/${bobId}`));
  assert.equal(bobHtml.includes(aliceId), false);
});

test("builder per-account sweep: skips legacy/anonymous drawings (no /u/ artifact)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);
  // Sidecar without account fields -> anonymous.
  await seedDrawing(root, "2026-04-19", 41);

  await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-20" });

  // No u/ directory should have been created at all.
  const uExists = await fs.stat(path.join(root, "public/u")).then(() => true, () => false);
  assert.equal(uExists, false);
});

test("builder writes null user_id + username for legacy inbox sidecars, drawing page renders 'anonymous'", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);

  // No seedOpts -> sidecar omits the account fields, like every drawing
  // submitted under the old anonymous keypair scheme.
  const id = await seedDrawing(root, "2026-04-19", 12);

  await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-20" });

  const jsonl = await fs.readFile(
    path.join(root, "public/days/2026-04-19/index.jsonl"),
    "utf8",
  );
  const lines = jsonl.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]) as IndexLine;
  assert.equal(entry.id, id);
  assert.equal(entry.user_id, null);
  assert.equal(entry.username, null);

  // Legacy drawing renders the 'anonymous' fallback (no /u/ link).
  const drawingHtml = await fs.readFile(path.join(root, `public/d/${id}.html`), "utf8");
  assert.match(drawingHtml, /<dt>Author<\/dt><dd>anonymous<\/dd>/);
  // Strip <script> blocks first — the children-hydration script contains
  // the literal string href="/u/..." as part of its DOM-building template,
  // but no actual anchor element is rendered.
  const sansScripts = drawingHtml.replace(/<script>[\s\S]*?<\/script>/g, "");
  assert.equal(/href="\/u\//.test(sansScripts), false);
});

test("builder renders streaks + badges on profile page when userStatsSource is wired", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);

  const user_id = "a".repeat(64);
  const username = "alice";
  await seedDrawing(root, "2026-04-19", 21, { user_id, username });

  const userStatsSource = {
    async get(uid: string) {
      if (uid !== user_id) return null;
      return {
        user_id,
        daily_total: 7,
        daily_streak_current: 3,
        daily_streak_longest: 5,
        daily_last_date: "2026-04-19",
        canvas_total: 2,
        canvas_streak_current: 1,
        canvas_streak_longest: 2,
        canvas_last_id: "canvas-2026-W16",
        updated_at: "2026-04-19T10:00:00Z",
      };
    },
  };

  await build({
    storage,
    publicBaseUrl: "https://example.test",
    today: "2026-04-20",
    userStatsSource,
  });

  const profileHtml = await fs.readFile(path.join(root, `public/u/${username}.html`), "utf8");
  assert.match(profileHtml, /<dl class="ow-stats">/);
  assert.match(profileHtml, /3-day streak/);
  assert.match(profileHtml, /best 5/);
  assert.match(profileHtml, /7 drawings total/);
  assert.match(profileHtml, /1-week streak/);
  assert.match(profileHtml, /2 canvases total/);
  assert.match(profileHtml, /data-badge-id="daily-7"/);
  assert.ok(
    !/data-badge-id="daily-30"/.test(profileHtml),
    "daily-30 should not appear at daily_total=7",
  );
  assert.ok(
    !/data-badge-id="canvas-10"/.test(profileHtml),
    "canvas-10 should not appear at canvas_total=2",
  );
});

test("builder omits stats block when userStatsSource is absent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);
  await seedDrawing(root, "2026-04-19", 22, { user_id: "a".repeat(64), username: "alice" });

  await build({ storage, publicBaseUrl: "https://example.test", today: "2026-04-20" });

  const profileHtml = await fs.readFile(path.join(root, `public/u/alice.html`), "utf8");
  assert.ok(!/<dl class="ow-stats">/.test(profileHtml), "no stats block without source");
});

test("builder emits the profile-page hydration script only when apiBaseUrl is set", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);
  const user_id = "a".repeat(64);
  const username = "alice";
  await seedDrawing(root, "2026-04-19", 23, { user_id, username });
  const userStatsSource = {
    async get() {
      return {
        user_id,
        daily_total: 1, daily_streak_current: 1, daily_streak_longest: 1,
        daily_last_date: "2026-04-19",
        canvas_total: 0, canvas_streak_current: 0, canvas_streak_longest: 0,
        canvas_last_id: null,
        updated_at: "2026-04-19T10:00:00Z",
      };
    },
  };

  // (1) With apiBaseUrl — script present, fetches the expected URL.
  await build({
    storage,
    publicBaseUrl: "https://example.test",
    today: "2026-04-20",
    userStatsSource,
    apiBaseUrl: "https://api.example.test",
  });
  const withApi = await fs.readFile(path.join(root, `public/u/${username}.html`), "utf8");
  assert.match(withApi, /data-stats-daily/, "expected hydration target attribute on the daily dd");
  assert.match(
    withApi,
    /fetch\("https:\/\/api\.example\.test\/users\/a{64}\/stats"\)/,
    "expected the hydration script to fetch the stats endpoint",
  );

  // (2) Without apiBaseUrl — stats block still rendered, but no script.
  const root2 = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage2 = new FsStorage(root2);
  await seedDrawing(root2, "2026-04-19", 23, { user_id, username });
  await build({
    storage: storage2,
    publicBaseUrl: "https://example.test",
    today: "2026-04-20",
    userStatsSource,
  });
  const noApi = await fs.readFile(path.join(root2, `public/u/${username}.html`), "utf8");
  assert.match(noApi, /<dl class="ow-stats">/);
  assert.ok(
    !/fetch\([^)]*\/stats/.test(noApi),
    "no hydration fetch when apiBaseUrl is absent",
  );
});

test("builder preserves canvas membership when re-rendering an existing drawing page", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-builder-"));
  const storage = new FsStorage(root);

  const id = await seedDrawing(root, "2026-04-19", 14, { user_id: "a".repeat(64), username: "alice" });

  // Seed the canvases sidecar at the same key ingest writes.
  const claimedBy = "c".repeat(64);
  const sidecarPath = path.join(root, `public/drawings/${id}.canvases.json`);
  await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
  await fs.writeFile(
    sidecarPath,
    JSON.stringify({
      drawing_id: id,
      canvases: [
        {
          id: "canvas-2026-W16",
          name: "Week 16, 2026",
          x: 3,
          y: 4,
          claimed_by: claimedBy,
          claimed_by_username: "carol",
        },
      ],
    }),
  );

  // forceRerender mirrors the deploy workflow's DRAWBANG_FORCE_RERENDER=1.
  await build({
    storage,
    publicBaseUrl: "https://example.test",
    today: "2026-04-20",
    forceRerender: true,
  });

  const drawingHtml = await fs.readFile(path.join(root, `public/d/${id}.html`), "utf8");
  assert.match(drawingHtml, /<dt>Canvases<\/dt>/);
  assert.match(
    drawingHtml,
    /href="\/canvases\/canvas-2026-W16#tile-3-4"/,
  );
  assert.ok(
    drawingHtml.includes(`/u/carol`),
    "expected claimed_by_username attribution in the canvas membership link",
  );
});
