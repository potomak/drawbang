import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { INITIAL_STATE, hashHex, leadingZeroBits, powHash, requiredBits, solve } from "../src/pow.js";
import type { Storage } from "../ingest/storage.js";
import { handleIngest } from "../ingest/handler.js";

// In-memory storage for testing — same Storage contract as FsStorage.
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

function makeGif(): Uint8Array {
  const frame = new Bitmap();
  for (let i = 0; i < 16; i++) frame.set(i, i, 3);
  return encodeGif({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });
}

test("ingest accepts a valid submission with virgin state", async () => {
  const storage = new MemoryStorage();
  const gif = makeGif();
  const baseline = INITIAL_STATE.last_publish_at;
  const bits = requiredBits(Number.POSITIVE_INFINITY); // 16
  const sol = await solve(gif, baseline, bits);

  const res = await handleIngest(
    {
      gif: Buffer.from(gif).toString("base64"),
      nonce: sol.nonce,
      baseline,
      solve_ms: sol.solveMs,
      bench_hps: 10000,
    },
    {
      storage,
      publicBaseUrl: "https://example.test",
      now: () => new Date("2026-04-18T12:00:00.000Z"),
    },
  );

  assert.equal(res.status, 202);
  assert.equal(res.body && "id" in res.body, true);
  const id = (res.body as { id: string }).id;
  assert.equal(id, sol.hashHex);
  assert.ok(await storage.exists(`inbox/2026-04-18/${id}.gif`));
  const state = await storage.getJSON<{ last_publish_at: string; last_difficulty_bits: number }>("public/state/last-publish.json");
  assert.equal(state?.last_publish_at, "2026-04-18T12:00:00.000Z");
  assert.equal(state?.last_difficulty_bits, 16);
});

test("ingest is idempotent — identical submission returns 200 with same id", async () => {
  const storage = new MemoryStorage();
  const gif = makeGif();
  const baseline = INITIAL_STATE.last_publish_at;
  const sol = await solve(gif, baseline, 16);
  const body = {
    gif: Buffer.from(gif).toString("base64"),
    nonce: sol.nonce,
    baseline,
    solve_ms: sol.solveMs,
    bench_hps: 5000,
  };
  const cfg = {
    storage,
    publicBaseUrl: "https://example.test",
    now: () => new Date("2026-04-18T12:00:00.000Z"),
  };
  const first = await handleIngest(body, cfg);
  const second = await handleIngest(body, cfg);
  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.deepEqual(
    (first.body as { id: string }).id,
    (second.body as { id: string }).id,
  );
});

test("ingest rejects tampered gifs whose PoW fails", async () => {
  const storage = new MemoryStorage();
  const gif = makeGif();
  const baseline = INITIAL_STATE.last_publish_at;
  const sol = await solve(gif, baseline, 16);

  const tampered = new Uint8Array(gif);
  tampered[tampered.length - 2] ^= 0xff;

  const res = await handleIngest(
    {
      gif: Buffer.from(tampered).toString("base64"),
      nonce: sol.nonce,
      baseline,
      solve_ms: sol.solveMs,
      bench_hps: 5000,
    },
    { storage, publicBaseUrl: "https://example.test", now: () => new Date() },
  );
  assert.equal(res.status, 400);
});

test("ingest requires baseline matching state or history", async () => {
  const storage = new MemoryStorage();
  // Seed state so it is not virgin.
  await storage.put(
    "public/state/last-publish.json",
    new TextEncoder().encode(
      JSON.stringify({ last_publish_at: "2026-04-18T11:00:00.000Z", last_difficulty_bits: 20 }),
    ),
    "application/json",
  );

  const gif = makeGif();
  const badBaseline = "2020-01-01T00:00:00.000Z";
  const sol = await solve(gif, badBaseline, 12); // low bits, don't waste time

  const res = await handleIngest(
    {
      gif: Buffer.from(gif).toString("base64"),
      nonce: sol.nonce,
      baseline: badBaseline,
      solve_ms: sol.solveMs,
      bench_hps: 5000,
    },
    { storage, publicBaseUrl: "https://example.test", now: () => new Date("2026-04-18T12:00:00.000Z") },
  );
  assert.equal(res.status, 400);
});

test("dynamic difficulty: second submission in the same second requires top-bracket bits", async () => {
  const storage = new MemoryStorage();
  const pubBase = "https://example.test";

  // Seed a just-happened publish.
  const justNow = "2026-04-18T12:00:00.000Z";
  await storage.put(
    "public/state/last-publish.json",
    new TextEncoder().encode(
      JSON.stringify({ last_publish_at: justNow, last_difficulty_bits: 16 }),
    ),
    "application/json",
  );

  const gif = makeGif();
  const baseline = justNow;
  const bits = requiredBits(0);
  assert.equal(bits, 24, "expected 24-bit bracket when baseline is this second");
  // Don't actually solve 24 bits here — just verify the bracket calc.
  // Submit with a 16-bit solution and confirm rejection.
  const weak = await solve(gif, baseline, 16);
  const res = await handleIngest(
    {
      gif: Buffer.from(gif).toString("base64"),
      nonce: weak.nonce,
      baseline,
      solve_ms: weak.solveMs,
      bench_hps: 5000,
    },
    { storage, publicBaseUrl: pubBase, now: () => new Date("2026-04-18T12:00:02.000Z") },
  );
  assert.equal(res.status, 400);
  const hash = await powHash(gif, baseline, weak.nonce);
  assert.ok(leadingZeroBits(hash) >= 16);
  assert.equal(hashHex(hash), weak.hashHex);
});
