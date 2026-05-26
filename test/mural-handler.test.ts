import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import {
  handleMuralClaim,
  handleMuralState,
  type MuralClaimRequest,
  type MuralHandlerConfig,
  type MuralStateResponseBody,
} from "../ingest/mural-handler.js";
import { MemoryMuralStore } from "../ingest/mural-store.js";
import { FsStorage } from "../ingest/storage.js";
import type { AuthedUser } from "../ingest/handler.js";
import { solveClaim } from "../src/pow.js";
import {
  muralIdForDate,
  muralOpensAt,
} from "../config/murals.js";

async function tmpStorage(): Promise<{ storage: FsStorage; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-mural-"));
  return { storage: new FsStorage(root), root };
}

// Pick a mural that's "active" for the chosen `now` — opens last Monday.
function liveMuralFor(now: Date): { muralId: string; opens: Date } {
  const id = muralIdForDate(now);
  return { muralId: id, opens: muralOpensAt(id) };
}

function authFor(userId: string): AuthedUser {
  return { user_id: userId, username: `u_${userId.slice(0, 6)}` };
}

const DEFAULT_USER = "a".repeat(64);

// Identity now comes from the verified JWT (cfg.auth); the claim PoW is keyed
// on the user_id, and the request body no longer carries pubkey/signature.
async function buildClaim(opts: {
  muralId: string;
  x: number;
  y: number;
  baseline: string;
  bits: number;
  userId?: string;
}): Promise<{ req: MuralClaimRequest; auth: AuthedUser }> {
  const userId = opts.userId ?? DEFAULT_USER;
  const solved = await solveClaim(
    { muralId: opts.muralId, x: opts.x, y: opts.y, userId },
    opts.baseline,
    opts.bits,
  );
  return {
    auth: authFor(userId),
    req: {
      mural_id: opts.muralId,
      x: opts.x,
      y: opts.y,
      baseline: opts.baseline,
      nonce: solved.nonce,
    },
  };
}

describe("POST /mural/claim", () => {
  test("happy path: returns 201 with claim_expires_at", async () => {
    const { storage } = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { muralId } = liveMuralFor(now);
    const baseline = "1970-01-01T00:00:00.000Z";
    const { req, auth } = await buildClaim({ muralId, x: 5, y: 12, baseline, bits: 14 });
    const r = await handleMuralClaim(req, {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
      auth,
      now: () => now,
    });
    assert.equal(r.status, 201);
    const body = r.body as { claim_expires_at: number; edit_url: string };
    assert.ok(body.claim_expires_at > Math.floor(now.getTime() / 1000));
    assert.equal(body.edit_url, `/?c=${muralId}&x=5&y=12`);
  });

  test("missing auth → 401", async () => {
    const { storage } = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { muralId } = liveMuralFor(now);
    const { req } = await buildClaim({
      muralId,
      x: 0,
      y: 0,
      baseline: "1970-01-01T00:00:00.000Z",
      bits: 14,
    });
    const r = await handleMuralClaim(req, {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    } as MuralHandlerConfig);
    assert.equal(r.status, 401);
  });

  test("locked mural → 403", async () => {
    const { storage } = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    // Today = 2026-05-13. Pick a mural that's already closed.
    const now = new Date("2026-05-13T12:00:00Z");
    const lockedMural = "mural-2026-W01"; // closed Jan 5, 2026.
    const { req, auth } = await buildClaim({
      muralId: lockedMural,
      x: 0,
      y: 0,
      baseline: "1970-01-01T00:00:00.000Z",
      bits: 14,
    });
    const r = await handleMuralClaim(req, {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
      auth,
      now: () => now,
    });
    assert.equal(r.status, 403);
  });

  test("insufficient PoW → 400", async () => {
    const { storage } = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { muralId } = liveMuralFor(now);
    // Trivial nonce won't satisfy 14 bits.
    const r = await handleMuralClaim(
      {
        mural_id: muralId,
        x: 0,
        y: 0,
        baseline: "1970-01-01T00:00:00.000Z",
        nonce: "0",
      },
      {
        storage,
        muralStore,
        publicBaseUrl: "https://example.test",
        auth: authFor(DEFAULT_USER),
        now: () => now,
      },
    );
    assert.equal(r.status, 400);
  });

  test("second account on same tile → 409", async () => {
    const { storage } = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { muralId } = liveMuralFor(now);
    const baseline = "1970-01-01T00:00:00.000Z";

    const first = await buildClaim({ muralId, x: 3, y: 4, baseline, bits: 14, userId: "a".repeat(64) });
    const r1 = await handleMuralClaim(first.req, {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
      auth: first.auth,
      now: () => now,
    });
    assert.equal(r1.status, 201);

    // After the first claim, last_claim_at = nowISO and the difficulty
    // curve rises (20 bits at age < 10s). Wait until the bracket drops back
    // to 14 bits (>600s) so the second account's PoW is verifiable cheaply.
    const now2 = new Date(now.getTime() + 700_000);
    const second = await buildClaim({
      muralId,
      x: 3,
      y: 4,
      baseline: now.toISOString(),
      bits: 14,
      userId: "b".repeat(64),
    });
    const r2 = await handleMuralClaim(second.req, {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
      auth: second.auth,
      now: () => now2,
    });
    assert.equal(r2.status, 409);
  });
});

describe("GET /mural/{id}/state", () => {
  test("unknown mural id → 404", async () => {
    const { storage } = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    const r = await handleMuralState("bogus", {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
    });
    assert.equal(r.status, 404);
  });

  test("empty mural → 200 with empty tiles", async () => {
    const { storage } = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { muralId } = liveMuralFor(now);
    const r = await handleMuralState(muralId, {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });
    assert.equal(r.status, 200);
    const body = r.body as MuralStateResponseBody;
    assert.equal(body.mural_id, muralId);
    assert.equal(body.tiles.length, 0);
    assert.equal(body.locked, false);
    assert.match(r.headers?.["Cache-Control"] ?? "", /max-age=15/);
  });

  test("reflects an active claim and a published tile", async () => {
    const { storage } = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { muralId } = liveMuralFor(now);
    const baseline = "1970-01-01T00:00:00.000Z";

    // Active claim on (1,1).
    const claim1 = await buildClaim({ muralId, x: 1, y: 1, baseline, bits: 14 });
    await handleMuralClaim(claim1.req, {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
      auth: claim1.auth,
      now: () => now,
    });

    // Direct DDB-style write for the published tile (we don't need to
    // exercise the ingest path here).
    await muralStore.claimTile({
      mural_id: muralId,
      tile_key: "2,2",
      user_id: "c".repeat(64),
      now_epoch: Math.floor(now.getTime() / 1000),
      ttl_s: 1800,
    });
    await muralStore.publishTile({
      mural_id: muralId,
      tile_key: "2,2",
      user_id: "c".repeat(64),
      drawing_id: "deadbeef",
      now_epoch: Math.floor(now.getTime() / 1000),
      cooldown_s: 900,
      cooldown_ttl_s: 7 * 86_400,
    });

    const r = await handleMuralState(muralId, {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });
    const body = r.body as MuralStateResponseBody;
    assert.equal(body.tiles.length, 2);
    const claimed = body.tiles.find((t) => t.x === 1 && t.y === 1);
    const published = body.tiles.find((t) => t.x === 2 && t.y === 2);
    assert.ok(claimed?.claimed_by);
    assert.equal(published?.drawing_id, "deadbeef");
  });

  test("required_bits reflects current age of last_claim_at, not last claim's difficulty", async () => {
    const { storage } = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    const t0 = new Date("2026-05-13T12:00:00Z");
    const { muralId } = liveMuralFor(t0);
    const baseline = "1970-01-01T00:00:00.000Z";

    // First-ever claim → server records last_difficulty_bits=14 (age=∞ bracket).
    const claim = await buildClaim({ muralId, x: 3, y: 4, baseline, bits: 14 });
    const claimRes = await handleMuralClaim(claim.req, {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
      auth: claim.auth,
      now: () => t0,
    });
    assert.equal(claimRes.status, 201);

    // 300s later — age sits in the (60s, 600s] bracket → 16 bits.
    const r = await handleMuralState(muralId, {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
      now: () => new Date(t0.getTime() + 300_000),
    });
    const body = r.body as MuralStateResponseBody;
    assert.equal(body.required_bits, 16);
    assert.equal(body.last_claim_at, t0.toISOString());
  });

  test("required_bits on a never-claimed mural → easiest bracket", async () => {
    const { storage } = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const { muralId } = liveMuralFor(now);
    const r = await handleMuralState(muralId, {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });
    const body = r.body as MuralStateResponseBody;
    assert.equal(body.required_bits, 14);
  });

  test("locked mural → immutable cache + locked:true", async () => {
    const { storage } = await tmpStorage();
    const muralStore = new MemoryMuralStore();
    const now = new Date("2026-05-13T12:00:00Z");
    const lockedMural = "mural-2026-W01";
    const r = await handleMuralState(lockedMural, {
      storage,
      muralStore,
      publicBaseUrl: "https://example.test",
      now: () => now,
    });
    assert.equal(r.status, 200);
    const body = r.body as MuralStateResponseBody;
    assert.equal(body.locked, true);
    assert.match(r.headers?.["Cache-Control"] ?? "", /immutable/);
  });
});
