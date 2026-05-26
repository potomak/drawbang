import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import {
  INITIAL_STATE,
  requiredBits,
  solve,
  solveClaim,
} from "../src/proof-of-work.js";
import type { Storage } from "../ingest/storage.js";
import { handleIngest, type AuthedUser, type IngestRequest } from "../ingest/handler.js";
import { handleMuralClaim } from "../ingest/mural-handler.js";
import { MemoryMuralStore } from "../ingest/mural-store.js";
import { MemoryUserStatsStore } from "../ingest/user-stats-store.js";
import { muralIdForDate, tileKey } from "../config/murals.js";

class MemoryStorage implements Storage {
  private store = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async putIfAbsent(key: string, bytes: Buffer | Uint8Array, contentType: string): Promise<boolean> {
    if (this.store.has(key)) return false;
    await this.put(key, bytes, contentType);
    return true;
  }
  async put(key: string, bytes: Buffer | Uint8Array, contentType: string): Promise<void> {
    this.store.set(key, { bytes: new Uint8Array(bytes), contentType });
  }
  async getJSON<T>(key: string): Promise<T | null> {
    const v = this.store.get(key);
    return v ? (JSON.parse(new TextDecoder().decode(v.bytes)) as T) : null;
  }
  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async listPrefix(prefix: string): Promise<string[]> {
    const out = new Set<string>();
    for (const key of this.store.keys()) {
      if (!key.startsWith(prefix + "/")) continue;
      const rest = key.slice(prefix.length + 1);
      const next = rest.split("/")[0];
      out.add(`${prefix}/${next}`);
    }
    return [...out];
  }
  async getBytes(key: string): Promise<Uint8Array | null> {
    return this.store.get(key)?.bytes ?? null;
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function mkAuth(hexChar: string): AuthedUser {
  return { user_id: hexChar.repeat(64), username: `u_${hexChar}` };
}

function makeGif(seed = 0): Uint8Array {
  const frame = new Bitmap();
  for (let i = 0; i < 16; i++) frame.set(i, (i + seed) % 16, 3);
  return encodeGif({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });
}

async function publishBody(
  gif: Uint8Array,
  baseline: string,
  extras: Partial<IngestRequest> = {},
): Promise<IngestRequest> {
  const bits = requiredBits(Number.POSITIVE_INFINITY);
  const sol = await solve(gif, baseline, bits);
  return {
    gif: Buffer.from(gif).toString("base64"),
    nonce: sol.nonce,
    baseline,
    solve_ms: sol.solveMs,
    bench_hps: 10_000,
    ...extras,
  };
}

async function claim(opts: {
  muralStore: MemoryMuralStore;
  storage: MemoryStorage;
  muralId: string;
  x: number;
  y: number;
  auth: AuthedUser;
  now: Date;
}): Promise<void> {
  const baseline = INITIAL_STATE.last_publish_at;
  const bits = requiredBits(Number.POSITIVE_INFINITY);
  const solved = await solveClaim(
    { muralId: opts.muralId, x: opts.x, y: opts.y, userId: opts.auth.user_id },
    baseline,
    bits,
  );
  const r = await handleMuralClaim(
    {
      mural_id: opts.muralId,
      x: opts.x,
      y: opts.y,
      baseline,
      nonce: solved.nonce,
    },
    {
      storage: opts.storage,
      muralStore: opts.muralStore,
      publicBaseUrl: "https://example.test",
      auth: opts.auth,
      now: () => opts.now,
    },
  );
  assert.equal(r.status, 201, `claim failed: ${JSON.stringify(r.body)}`);
}

describe("ingest + mural_claim", () => {
  test("publish refreshes current-mural snapshot with live tile count", async () => {
    const storage = new MemoryStorage();
    const muralStore = new MemoryMuralStore();
    const auth = mkAuth("a");
    const now = new Date("2026-05-13T12:00:00Z");
    const muralId = muralIdForDate(now);

    await claim({ muralStore, storage, muralId, x: 3, y: 7, auth, now });
    const body = await publishBody(makeGif(), INITIAL_STATE.last_publish_at, {
      mural_claim: { mural_id: muralId, x: 3, y: 7 },
    });
    const r = await handleIngest(body, {
      storage,
      publicBaseUrl: "https://example.test",
      auth,
      muralStore,
      now: () => now,
    });
    assert.equal(r.status, 202);

    const snapshot = await storage.getJSON<{
      mural_id: string;
      name: string;
      tiles_published: number;
      tiles_claimed: number;
      tiles_total: number;
    }>("public/state/current-mural.json");
    assert.ok(snapshot, "snapshot should be written");
    assert.equal(snapshot.mural_id, muralId);
    assert.equal(snapshot.tiles_published, 1);
    assert.equal(snapshot.tiles_claimed, 0);
    assert.equal(snapshot.tiles_total, 256);
  });

  test("publish with valid mural_claim → 202 + tile published + membership recorded", async () => {
    const storage = new MemoryStorage();
    const muralStore = new MemoryMuralStore();
    const auth = mkAuth("a");
    const now = new Date("2026-05-13T12:00:00Z");
    const muralId = muralIdForDate(now);

    await claim({ muralStore, storage, muralId, x: 5, y: 12, auth, now });

    const gif = makeGif();
    const body = await publishBody(gif, INITIAL_STATE.last_publish_at, {
      mural_claim: { mural_id: muralId, x: 5, y: 12 },
    });
    const r = await handleIngest(body, {
      storage,
      publicBaseUrl: "https://example.test",
      auth,
      muralStore,
      now: () => now,
    });
    assert.equal(r.status, 202);
    if (r.status !== 202) return;
    assert.equal(r.body.mural?.mural_id, muralId);
    assert.equal(r.body.mural?.x, 5);

    // Tile in store has drawing_id set.
    const tiles = await muralStore.getTiles(muralId);
    const tile = tiles.find((t) => t.x === 5 && t.y === 12);
    assert.equal(tile?.drawing_id, r.body.id);

    // Murals file written.
    const memberFile = await storage.getJSON<{
      drawing_id: string;
      murals: Array<{ id: string; x: number; y: number; claimed_by: string; claimed_by_username: string }>;
    }>(`public/tiles/${r.body.id}.murals.json`);
    assert.equal(memberFile?.murals.length, 1);
    assert.equal(memberFile?.murals[0].id, muralId);
    assert.equal(memberFile?.murals[0].x, 5);
    assert.equal(memberFile?.murals[0].claimed_by_username, auth.username);

    // Drawing page contains the mural section.
    const html = await storage.getBytes(`public/t/${r.body.id}.html`);
    assert.ok(html);
    const htmlStr = new TextDecoder().decode(html);
    assert.match(htmlStr, /Murals/);
    assert.match(htmlStr, new RegExp(`/murals/${muralId}`));
  });

  test("publish with mural_claim but no prior claim → 403", async () => {
    const storage = new MemoryStorage();
    const muralStore = new MemoryMuralStore();
    const auth = mkAuth("a");
    const now = new Date("2026-05-13T12:00:00Z");
    const muralId = muralIdForDate(now);

    const gif = makeGif();
    const body = await publishBody(gif, INITIAL_STATE.last_publish_at, {
      mural_claim: { mural_id: muralId, x: 5, y: 12 },
    });
    const r = await handleIngest(body, {
      storage,
      publicBaseUrl: "https://example.test",
      auth,
      muralStore,
      now: () => now,
    });
    assert.equal(r.status, 403);
  });

  test("publish with mural_claim on a locked mural → 403", async () => {
    const storage = new MemoryStorage();
    const muralStore = new MemoryMuralStore();
    const auth = mkAuth("a");
    const now = new Date("2026-05-13T12:00:00Z");
    const lockedMural = "mural-2026-W01";

    const gif = makeGif();
    const body = await publishBody(gif, INITIAL_STATE.last_publish_at, {
      mural_claim: { mural_id: lockedMural, x: 5, y: 12 },
    });
    const r = await handleIngest(body, {
      storage,
      publicBaseUrl: "https://example.test",
      auth,
      muralStore,
      now: () => now,
    });
    assert.equal(r.status, 403);
  });

  test("same gif into two different murals → both succeed, sidecar has 2 entries", async () => {
    const storage = new MemoryStorage();
    const muralStore = new MemoryMuralStore();
    const auth = mkAuth("a");
    const gif = makeGif();

    // First mural: current week
    const now1 = new Date("2026-05-13T12:00:00Z");
    const muralA = muralIdForDate(now1);
    await claim({ muralStore, storage, muralId: muralA, x: 0, y: 0, auth, now: now1 });
    const body1 = await publishBody(gif, INITIAL_STATE.last_publish_at, {
      mural_claim: { mural_id: muralA, x: 0, y: 0 },
    });
    const r1 = await handleIngest(body1, {
      storage,
      publicBaseUrl: "https://example.test",
      auth,
      muralStore,
      now: () => now1,
    });
    assert.equal(r1.status, 202);
    if (r1.status !== 202) return;
    const drawingId = r1.body.id;

    // Second mural: a week later, after cooldown elapses
    const now2 = new Date(now1.getTime() + 8 * 86_400_000);
    const muralB = muralIdForDate(now2);
    assert.notEqual(muralA, muralB);
    await claim({ muralStore, storage, muralId: muralB, x: 1, y: 2, auth, now: now2 });
    const stateForBaseline = (await storage.getJSON<{ last_publish_at: string }>(
      "public/state/last-publish.json",
    ))!;
    const body2 = await publishBody(gif, stateForBaseline.last_publish_at, {
      mural_claim: { mural_id: muralB, x: 1, y: 2 },
    });
    const r2 = await handleIngest(body2, {
      storage,
      publicBaseUrl: "https://example.test",
      auth,
      muralStore,
      now: () => now2,
    });
    assert.equal(r2.status, 202);
    if (r2.status !== 202) return;
    assert.equal(r2.body.id, drawingId, "same gif yields same content-addressed id");

    // Sidecar shows membership in BOTH murals.
    const memberFile = await storage.getJSON<{
      murals: Array<{ id: string; x: number; y: number }>;
    }>(`public/tiles/${drawingId}.murals.json`);
    assert.equal(memberFile?.murals.length, 2);
    const ids = memberFile?.murals.map((c) => c.id).sort();
    assert.deepEqual(ids, [muralA, muralB].sort());
  });

  test("publishTile on already-published tile rejects (covered by mural-store unit)", async () => {
    const storage = new MemoryStorage();
    const muralStore = new MemoryMuralStore();
    const authA = mkAuth("a");
    const authB = mkAuth("b");
    const now = new Date("2026-05-13T12:00:00Z");
    const muralId = muralIdForDate(now);

    await claim({ muralStore, storage, muralId, x: 0, y: 0, auth: authA, now });
    const gifA = makeGif(0);
    const bodyA = await publishBody(gifA, INITIAL_STATE.last_publish_at, {
      mural_claim: { mural_id: muralId, x: 0, y: 0 },
    });
    const rA = await handleIngest(bodyA, {
      storage,
      publicBaseUrl: "https://example.test",
      auth: authA,
      muralStore,
      now: () => now,
    });
    assert.equal(rA.status, 202);

    // B tries to publish onto the same tile without ever claiming it.
    // Wait 700s so global PoW drops back to the 14-bit bracket.
    const nowB = new Date(now.getTime() + 700_000);
    const baselineB = (await storage.getJSON<{ last_publish_at: string }>(
      "public/state/last-publish.json",
    ))!.last_publish_at;
    const gifB = makeGif(5);
    const bodyB = await publishBody(gifB, baselineB, {
      mural_claim: { mural_id: muralId, x: 0, y: 0 },
    });
    const rB = await handleIngest(bodyB, {
      storage,
      publicBaseUrl: "https://example.test",
      auth: authB,
      muralStore,
      now: () => nowB,
    });
    assert.ok(
      rB.status === 403 || rB.status === 409,
      `expected 403/409, got ${rB.status}: ${JSON.stringify(rB.body)}`,
    );
  });

  test("publish during cooldown → 429", async () => {
    const storage = new MemoryStorage();
    const muralStore = new MemoryMuralStore();
    const auth = mkAuth("a");
    const now = new Date("2026-05-13T12:00:00Z");
    const muralId = muralIdForDate(now);

    // First publish.
    await claim({ muralStore, storage, muralId, x: 0, y: 0, auth, now });
    const gif1 = makeGif(0);
    const body1 = await publishBody(gif1, INITIAL_STATE.last_publish_at, {
      mural_claim: { mural_id: muralId, x: 0, y: 0 },
    });
    const r1 = await handleIngest(body1, {
      storage,
      publicBaseUrl: "https://example.test",
      auth,
      muralStore,
      now: () => now,
    });
    assert.equal(r1.status, 202);

    // Second publish a minute later — within the 15-min cooldown.
    const now2 = new Date(now.getTime() + 60_000);
    // Bump now3 past 600s so global publish-PoW drops to 14 bits.
    const now3 = new Date(now.getTime() + 700_000);
    await claim({ muralStore, storage, muralId, x: 1, y: 0, auth, now: now3 });
    const baseline = (await storage.getJSON<{ last_publish_at: string }>(
      "public/state/last-publish.json",
    ))!.last_publish_at;
    const gif2 = makeGif(3);
    const body2 = await publishBody(gif2, baseline, {
      mural_claim: { mural_id: muralId, x: 1, y: 0 },
    });
    const r2 = await handleIngest(body2, {
      storage,
      publicBaseUrl: "https://example.test",
      auth,
      muralStore,
      now: () => now3,
    });
    assert.equal(r2.status, 429);
    if (r2.status === 429) {
      assert.ok((r2.body.retry_after_s ?? 0) > 0);
    }
    void now2;
    void tileKey;
  });

  test("publish bumps both daily + mural counters via userStatsStore", async () => {
    const storage = new MemoryStorage();
    const muralStore = new MemoryMuralStore();
    const userStatsStore = new MemoryUserStatsStore();
    const auth = mkAuth("a");
    const now = new Date("2026-05-13T12:00:00Z");
    const muralId = muralIdForDate(now);

    await claim({ muralStore, storage, muralId, x: 5, y: 5, auth, now });
    const body = await publishBody(makeGif(2), INITIAL_STATE.last_publish_at, {
      mural_claim: { mural_id: muralId, x: 5, y: 5 },
    });
    const r = await handleIngest(body, {
      storage,
      publicBaseUrl: "https://example.test",
      auth,
      muralStore,
      userStatsStore,
      now: () => now,
    });
    assert.equal(r.status, 202);

    const stats = await userStatsStore.get(auth.user_id);
    assert.ok(stats, "expected a user-stats row to be written");
    assert.equal(stats.daily_total, 1);
    assert.equal(stats.daily_streak_current, 1);
    assert.equal(stats.daily_last_date, "2026-05-13");
    assert.equal(stats.mural_total, 1);
    assert.equal(stats.mural_streak_current, 1);
    assert.equal(stats.mural_last_id, muralId);
  });

  test("re-publishing same gif into a NEW mural tile bumps mural_total but NOT daily_total", async () => {
    const storage = new MemoryStorage();
    const muralStore = new MemoryMuralStore();
    const userStatsStore = new MemoryUserStatsStore();
    const auth = mkAuth("a");
    const now = new Date("2026-05-13T12:00:00Z");
    const muralId = muralIdForDate(now);

    // First publish — into (5,5). Both counters bump.
    await claim({ muralStore, storage, muralId, x: 5, y: 5, auth, now });
    const gif = makeGif(3);
    const body1 = await publishBody(gif, INITIAL_STATE.last_publish_at, {
      mural_claim: { mural_id: muralId, x: 5, y: 5 },
    });
    const r1 = await handleIngest(body1, {
      storage,
      publicBaseUrl: "https://example.test",
      auth,
      muralStore,
      userStatsStore,
      now: () => now,
    });
    assert.equal(r1.status, 202);

    // Distinct mural a week later to legitimately bump mural_total again.
    const nowNext = new Date("2026-05-20T12:00:00Z");
    const muralIdNext = muralIdForDate(nowNext);
    assert.notEqual(muralId, muralIdNext);
    await claim({ muralStore, storage, muralId: muralIdNext, x: 1, y: 1, auth, now: nowNext });
    const body2 = await publishBody(gif, INITIAL_STATE.last_publish_at, {
      mural_claim: { mural_id: muralIdNext, x: 1, y: 1 },
    });
    const r2 = await handleIngest(body2, {
      storage,
      publicBaseUrl: "https://example.test",
      auth,
      muralStore,
      userStatsStore,
      now: () => nowNext,
    });
    assert.equal(r2.status, 202);

    const stats = await userStatsStore.get(auth.user_id);
    assert.ok(stats);
    assert.equal(stats.daily_total, 1, "daily_total must not bump on re-publish of an existing gif");
    assert.equal(stats.mural_total, 2);
    assert.equal(stats.mural_streak_current, 2);
    assert.equal(stats.mural_last_id, muralIdNext);
  });

  test("publish writes the 960x960 -large.gif alongside the 16x16 original", async () => {
    const storage = new MemoryStorage();
    const auth = mkAuth("a");
    const now = new Date("2026-05-13T12:00:00Z");
    const gif = makeGif(99);
    const body = await publishBody(gif, INITIAL_STATE.last_publish_at);
    const r = await handleIngest(body, {
      storage,
      publicBaseUrl: "https://example.test",
      auth,
      now: () => now,
    });
    assert.equal(r.status, 202);
    if (r.status !== 202) return;
    const id = r.body.id;

    const large = await storage.getBytes(`public/tiles/${id}-large.gif`);
    assert.ok(large, "expected -large.gif to be written");
    // GIF89a magic header. Crawlers sniff the magic before content-type.
    assert.equal(large[0], 0x47); // G
    assert.equal(large[1], 0x49); // I
    assert.equal(large[2], 0x46); // F
    // Logical screen descriptor width/height live at bytes 6-9, little-endian.
    const w = large[6] | (large[7] << 8);
    const h = large[8] | (large[9] << 8);
    assert.equal(w, 960);
    assert.equal(h, 960);
  });
});
