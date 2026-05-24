import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { INITIAL_STATE, contentHash, hashHex, leadingZeroBits, powHash, requiredBits, solve } from "../src/pow.js";
import type { Storage } from "../ingest/storage.js";
import {
  handleIngest,
  type AuthedUser,
  type HandlerConfig,
  type IngestRequest,
} from "../ingest/handler.js";

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

const ALICE: AuthedUser = { user_id: "a".repeat(64), username: "alice" };
const BOB: AuthedUser = { user_id: "b".repeat(64), username: "bob" };

function makeGif(): Uint8Array {
  const frame = new Bitmap();
  for (let i = 0; i < 16; i++) frame.set(i, i, 3);
  return encodeGif({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });
}

// Identity now comes from the verified JWT (cfg.auth), not the request body.
function reqBody(
  gif: Uint8Array,
  sol: { nonce: string; solveMs: number },
  baseline: string,
  extras: Partial<IngestRequest> = {},
): IngestRequest {
  return {
    gif: Buffer.from(gif).toString("base64"),
    nonce: sol.nonce,
    baseline,
    solve_ms: sol.solveMs,
    bench_hps: 5000,
    ...extras,
  };
}

function cfg(over: Partial<HandlerConfig> & { now?: () => Date } = {}): HandlerConfig {
  return {
    storage: new MemoryStorage(),
    publicBaseUrl: "https://example.test",
    auth: ALICE,
    now: () => new Date("2026-04-18T12:00:00.000Z"),
    ...over,
  };
}

test("ingest accepts a valid submission with virgin state", async () => {
  const storage = new MemoryStorage();
  const gif = makeGif();
  const baseline = INITIAL_STATE.last_publish_at;
  const bits = requiredBits(Number.POSITIVE_INFINITY); // 14
  const sol = await solve(gif, baseline, bits);

  const res = await handleIngest(
    reqBody(gif, sol, baseline, { bench_hps: 10000 }),
    cfg({ storage }),
  );

  assert.equal(res.status, 202);
  assert.equal(res.body && "id" in res.body, true);
  const id = (res.body as { id: string }).id;
  assert.equal(id, hashHex(await contentHash(gif)));
  assert.ok(await storage.exists(`inbox/2026-04-18/${id}.gif`));
  const meta = await storage.getJSON<{ id: string; pow: string; user_id: string; username: string }>(`inbox/2026-04-18/${id}.json`);
  assert.equal(meta?.id, id);
  assert.equal(meta?.pow, sol.hashHex);
  // Account fields persisted on the inbox sidecar
  assert.equal(meta?.user_id, ALICE.user_id);
  assert.equal(meta?.username, ALICE.username);
  const state = await storage.getJSON<{ last_publish_at: string; last_difficulty_bits: number }>("public/state/last-publish.json");
  assert.equal(state?.last_publish_at, "2026-04-18T12:00:00.000Z");
  assert.equal(state?.last_difficulty_bits, 14);
});

test("ingest id is stable across different nonce/baseline for the same gif", async () => {
  const gif = makeGif();
  const id1 = hashHex(await contentHash(gif));
  const id2 = hashHex(await contentHash(gif));
  assert.equal(id1, id2);

  const storage = new MemoryStorage();
  const baselineA = INITIAL_STATE.last_publish_at;
  const solA = await solve(gif, baselineA, 16);
  const first = await handleIngest(reqBody(gif, solA, baselineA), cfg({ storage }));
  assert.equal(first.status, 202);

  // Second submit uses a fresh baseline (the one the first submit just set)
  // and a brand new PoW nonce. Same gif bytes, so same id.
  const baselineB = "2026-04-18T12:00:00.000Z";
  const solB = await solve(gif, baselineB, 16);
  const second = await handleIngest(
    reqBody(gif, solB, baselineB),
    cfg({ storage, now: () => new Date("2026-04-18T13:00:01.000Z") }),
  );
  assert.equal(second.status, 200, "second submit should be idempotent");
  assert.equal((first.body as { id: string }).id, id1);
  assert.equal((second.body as { id: string }).id, id1);
  assert.notEqual(solA.hashHex, solB.hashHex, "sanity: PoW hashes differ");
});

test("ingest is idempotent — identical submission returns 200 with same id", async () => {
  const storage = new MemoryStorage();
  const gif = makeGif();
  const baseline = INITIAL_STATE.last_publish_at;
  const sol = await solve(gif, baseline, 16);
  const body = reqBody(gif, sol, baseline);
  const c = cfg({ storage });
  const first = await handleIngest(body, c);
  const second = await handleIngest(body, c);
  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.deepEqual(
    (first.body as { id: string }).id,
    (second.body as { id: string }).id,
  );
});

test("ingest first-owner-wins: duplicate gif from a different account gets the existing id", async () => {
  // Re-uses the existing idempotency branch; no new code path. This is the
  // contract that makes the CLAUDE.md content-addressed-id invariant hold.
  const storage = new MemoryStorage();
  const gif = makeGif();
  const baseline = INITIAL_STATE.last_publish_at;
  const sol = await solve(gif, baseline, 14);
  const id = hashHex(await contentHash(gif));

  const first = await handleIngest(reqBody(gif, sol, baseline), cfg({ storage, auth: ALICE }));
  assert.equal(first.status, 202);
  // bob re-publishes the same gif; gets back the existing id. The on-disk
  // metadata still belongs to alice (first-owner-wins).
  const second = await handleIngest(reqBody(gif, sol, baseline), cfg({ storage, auth: BOB }));
  assert.equal(second.status, 200);
  assert.equal((second.body as { id: string }).id, id);
  const meta = await storage.getJSON<{ user_id: string }>(`inbox/2026-04-18/${id}.json`);
  assert.equal(meta?.user_id, ALICE.user_id);
});

test("ingest rejects tampered gifs whose PoW fails", async () => {
  const storage = new MemoryStorage();
  const gif = makeGif();
  const baseline = INITIAL_STATE.last_publish_at;
  const sol = await solve(gif, baseline, 16);

  const tampered = new Uint8Array(gif);
  tampered[tampered.length - 2] ^= 0xff;

  // PoW is computed over the tampered gif (which doesn't satisfy the bits
  // target for that nonce). PoW check should fire.
  const res = await handleIngest(
    {
      ...reqBody(gif, sol, baseline),
      gif: Buffer.from(tampered).toString("base64"),
    },
    cfg({ storage, now: () => new Date() }),
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

  const res = await handleIngest(reqBody(gif, sol, badBaseline), cfg({ storage }));
  assert.equal(res.status, 400);
});

test("dynamic difficulty: second submission in the same second requires top-bracket bits", async () => {
  const storage = new MemoryStorage();

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
  assert.equal(bits, 20, "expected 20-bit bracket when baseline is this second");
  // Submit with a 16-bit solution and confirm rejection.
  const weak = await solve(gif, baseline, 16);
  const res = await handleIngest(
    reqBody(gif, weak, baseline),
    cfg({ storage, now: () => new Date("2026-04-18T12:00:02.000Z") }),
  );
  assert.equal(res.status, 400);
  const hash = await powHash(gif, baseline, weak.nonce);
  assert.ok(leadingZeroBits(hash) >= 16);
  assert.equal(hashHex(hash), weak.hashHex);
});

// ---- Fork lineage: parent -> children sidecar -------------------------------

function makeGifWithMarker(marker: number): Uint8Array {
  const frame = new Bitmap();
  for (let i = 0; i < 16; i++) frame.set(i, i, marker & 0x0f);
  frame.set(0, 15, marker & 0x0f); // distinguishes from the diagonal-only gif
  return encodeGif({ frames: [frame], activePalette: DEFAULT_ACTIVE_PALETTE });
}

interface ChildEntry {
  id: string;
  id_short: string;
  user_id: string;
  username: string;
  created_at: string;
}
interface ChildrenFile {
  drawing_id: string;
  children: ChildEntry[];
}

async function publishVirgin(
  storage: MemoryStorage,
  gif: Uint8Array,
  auth: AuthedUser,
  nowISO: string,
  extras: Partial<IngestRequest> = {},
): Promise<string> {
  const baseline = INITIAL_STATE.last_publish_at;
  const sol = await solve(gif, baseline, 14);
  const res = await handleIngest(
    reqBody(gif, sol, baseline, extras),
    cfg({ storage, auth, now: () => new Date(nowISO) }),
  );
  assert.equal(res.status, 202);
  return (res.body as { id: string }).id;
}

async function publishWithBaseline(
  storage: MemoryStorage,
  gif: Uint8Array,
  auth: AuthedUser,
  baseline: string,
  nowISO: string,
  history: string[],
  extras: Partial<IngestRequest> = {},
): Promise<{ id: string; status: number }> {
  const sol = await solve(gif, baseline, 14);
  const res = await handleIngest(
    reqBody(gif, sol, baseline, extras),
    cfg({ storage, auth, now: () => new Date(nowISO), baselineHistory: history }),
  );
  return { id: (res.body as { id: string }).id, status: res.status };
}

test("ingest records a child entry on the parent's children.json", async () => {
  const storage = new MemoryStorage();
  const parentId = await publishVirgin(
    storage,
    makeGifWithMarker(0xa),
    ALICE,
    "2026-04-18T12:00:00.000Z",
  );

  const history: string[] = [];
  const childAuthor: AuthedUser = { user_id: "c".repeat(64), username: "carol" };
  const { id: childId, status } = await publishWithBaseline(
    storage,
    makeGifWithMarker(0xb),
    childAuthor,
    "2026-04-18T12:00:00.000Z",
    "2026-04-18T12:11:00.000Z",
    history,
    { parent: parentId },
  );
  assert.equal(status, 202);

  const file = await storage.getJSON<ChildrenFile>(
    `public/drawings/${parentId}.children.json`,
  );
  assert.ok(file, "children.json should exist on the parent");
  assert.equal(file.drawing_id, parentId);
  assert.equal(file.children.length, 1);
  assert.equal(file.children[0].id, childId);
  assert.equal(file.children[0].id_short, childId.slice(0, 8));
  assert.equal(file.children[0].username, childAuthor.username);
  assert.equal(file.children[0].created_at, "2026-04-18T12:11:00.000Z");
});

test("ingest collects multiple children of the same parent in publish order", async () => {
  const storage = new MemoryStorage();
  const parentId = await publishVirgin(
    storage,
    makeGifWithMarker(0x1),
    ALICE,
    "2026-04-18T12:00:00.000Z",
  );

  const history: string[] = [];
  const childA = await publishWithBaseline(
    storage,
    makeGifWithMarker(0x2),
    BOB,
    "2026-04-18T12:00:00.000Z",
    "2026-04-18T12:11:00.000Z",
    history,
    { parent: parentId },
  );
  assert.equal(childA.status, 202);

  const childB = await publishWithBaseline(
    storage,
    makeGifWithMarker(0x3),
    { user_id: "d".repeat(64), username: "dave" },
    "2026-04-18T12:11:00.000Z",
    "2026-04-18T12:22:00.000Z",
    history,
    { parent: parentId },
  );
  assert.equal(childB.status, 202);

  const file = await storage.getJSON<ChildrenFile>(
    `public/drawings/${parentId}.children.json`,
  );
  assert.equal(file?.children.length, 2);
  assert.equal(file?.children[0].id, childA.id);
  assert.equal(file?.children[1].id, childB.id);
});

test("ingest de-dupes a re-published child against the same parent", async () => {
  const storage = new MemoryStorage();
  const parentId = await publishVirgin(
    storage,
    makeGifWithMarker(0x4),
    ALICE,
    "2026-04-18T12:00:00.000Z",
  );

  const childGif = makeGifWithMarker(0x5);
  const history: string[] = [];

  const first = await publishWithBaseline(
    storage,
    childGif,
    BOB,
    "2026-04-18T12:00:00.000Z",
    "2026-04-18T12:11:00.000Z",
    history,
    { parent: parentId },
  );
  assert.equal(first.status, 202);

  // Second publish of the same gif (idempotent retry) should hit the
  // alreadyHere short-circuit, return 200, and NOT grow the children list.
  const second = await publishWithBaseline(
    storage,
    childGif,
    BOB,
    "2026-04-18T12:11:00.000Z",
    "2026-04-18T12:22:00.000Z",
    history,
    { parent: parentId },
  );
  assert.equal(second.status, 200);

  const file = await storage.getJSON<ChildrenFile>(
    `public/drawings/${parentId}.children.json`,
  );
  assert.equal(file?.children.length, 1);
});

test("ingest skips children write when parent === id (self-fork guard)", async () => {
  const storage = new MemoryStorage();
  const gif = makeGifWithMarker(0x6);
  const id = hashHex(await contentHash(gif));
  await publishVirgin(
    storage,
    gif,
    ALICE,
    "2026-04-18T12:00:00.000Z",
    { parent: id },
  );
  const file = await storage.getJSON<ChildrenFile>(
    `public/drawings/${id}.children.json`,
  );
  assert.equal(file, null);
});

test("ingest silently ignores a malformed parent field", async () => {
  const storage = new MemoryStorage();
  await publishVirgin(
    storage,
    makeGifWithMarker(0x7),
    ALICE,
    "2026-04-18T12:00:00.000Z",
    { parent: "not-64-hex" },
  );
  const keys = await storage.listPrefix("public/drawings");
  const childrenFiles = keys.filter((k) => k.endsWith(".children.json"));
  assert.equal(childrenFiles.length, 0);
});
