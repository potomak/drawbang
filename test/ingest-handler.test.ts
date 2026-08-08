import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  encodeShareMp4FromStorage,
  handleIngest,
  isEncodeShareMp4Event,
  isPostPublishEvent,
  runPostPublish,
  type PostPublishJob,
  type AuthedUser,
} from "../ingest/handler.js";
import type { Storage } from "../ingest/storage.js";
import { MemoryDrawingStore } from "../ingest/drawing-store.js";
import { NoopInvalidator } from "../ingest/cache-invalidation.js";
import { PROMPTS, promptForDate } from "../config/prompts.js";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { contentHashHex } from "../src/content-hash.js";
import { MemoryUserStatsStore } from "../ingest/user-stats-store.js";
import { ANONYMOUS_USER_ID, ANONYMOUS_USERNAME } from "../config/constants.js";

// In-memory Storage that records every put() call. Avoids touching the
// filesystem from tests and lets assertions reach into `puts` to check
// what handleIngest wrote.
class MemoryStorage implements Storage {
  readonly puts: Array<{ key: string; bytes: Uint8Array }> = [];
  private readonly store = new Map<string, Uint8Array>();

  async putIfAbsent(
    key: string,
    bytes: Buffer | Uint8Array,
    contentType: string,
    cacheControl?: string,
  ): Promise<boolean> {
    if (this.store.has(key)) return false;
    await this.put(key, bytes, contentType, cacheControl);
    return true;
  }
  async put(
    key: string,
    bytes: Buffer | Uint8Array,
    _contentType: string,
    _cacheControl?: string,
  ): Promise<void> {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.store.set(key, u);
    this.puts.push({ key, bytes: u });
  }
  async getJSON<T>(_key: string): Promise<T | null> { return null; }
  async exists(key: string): Promise<boolean> { return this.store.has(key); }
  async listPrefix(_prefix: string): Promise<string[]> { return []; }
  async getBytes(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }
  async remove(key: string): Promise<void> { this.store.delete(key); }
}

const PUBLIC_BASE = "https://example.test";
const AUTH: AuthedUser = {
  user_id: "u".repeat(64),
  username: "alice",
};

function bmp(seedPixel: number): Bitmap {
  // One coloured pixel against the rest-transparent canvas so different
  // seeds produce different content-addressed ids.
  const b = new Bitmap(16, 16);
  b.data[0] = seedPixel & 0x0f;
  return b;
}

function makeGif(seed = 1): Uint8Array {
  return encodeGif({
    frames: [bmp(seed)],
    activePalette: new Uint8Array(DEFAULT_ACTIVE_PALETTE),
    size: 16,
  });
}

function makeHarness() {
  return {
    storage: new MemoryStorage(),
    drawingStore: new MemoryDrawingStore(),
  };
}

describe("handleIngest", () => {
  test("rejects non-base64 garbage with 400 bad base64", async () => {
    const h = makeHarness();
    const res = await handleIngest(
      { gif: "this is not base64 !!!" },
      { storage: h.storage, publicBaseUrl: PUBLIC_BASE, auth: AUTH, drawingStore: h.drawingStore },
    );
    // Buffer.from is lenient and will decode any string; the rejection
    // lands at validateGif as 'gif too short' or 'not a GIF89a'. Either
    // way the failure is a 400 with a useful enum-mappable prefix.
    assert.equal(res.status, 400);
    const body = res.body as { error: string };
    assert.match(body.error, /^invalid gif:|^bad base64:/);
    assert.equal(h.storage.puts.length, 0);
  });

  test("rejects bytes that aren't GIF89a with 400 invalid gif", async () => {
    const h = makeHarness();
    const notAGif = Buffer.from("just plain text padded to 13+ bytes here").toString("base64");
    const res = await handleIngest(
      { gif: notAGif },
      { storage: h.storage, publicBaseUrl: PUBLIC_BASE, auth: AUTH, drawingStore: h.drawingStore },
    );
    assert.equal(res.status, 400);
    const body = res.body as { error: string };
    assert.match(body.error, /^invalid gif: not a GIF89a/);
    assert.equal(h.storage.puts.length, 0);
  });

  test("rejects a GIF that lacks the DRAWBANG application extension", async () => {
    const h = makeHarness();
    // Strip the DRAWBANG sub-block from a real editor gif and the
    // validator should reject it as 'missing application extension'.
    // Easiest way: hand-craft a minimal GIF89a with a global colour
    // table + image frame but no DRAWBANG block. We just take the
    // editor gif and chop the Application Extension out.
    const editorGif = makeGif(1);
    const stripped = stripDrawbangExtension(editorGif);
    const b64 = Buffer.from(stripped).toString("base64");
    const res = await handleIngest(
      { gif: b64 },
      { storage: h.storage, publicBaseUrl: PUBLIC_BASE, auth: AUTH, drawingStore: h.drawingStore },
    );
    assert.equal(res.status, 400);
    const body = res.body as { error: string };
    assert.match(body.error, /^invalid gif: gif missing DRAWBANG application extension/);
  });

  test("first publish returns 202 with the content-addressed id + writes the gif", async () => {
    const h = makeHarness();
    const gif = makeGif(1);
    const id = await contentHashHex(gif);
    const res = await handleIngest(
      { gif: Buffer.from(gif).toString("base64") },
      { storage: h.storage, publicBaseUrl: PUBLIC_BASE, auth: AUTH, drawingStore: h.drawingStore },
    );
    assert.equal(res.status, 202);
    const body = res.body as { id: string; share_url: string };
    assert.equal(body.id, id);
    assert.equal(body.share_url, `${PUBLIC_BASE}/d/${id}`);
    const keys = h.storage.puts.map((p) => p.key);
    assert.ok(keys.includes(`public/tiles/${id}.gif`), `expected gif put, got ${keys.join(",")}`);
  });

  test("re-publishing the same bytes is idempotent: 200 + same id, no second write", async () => {
    const h = makeHarness();
    const gif = makeGif(1);
    const b64 = Buffer.from(gif).toString("base64");

    const first = await handleIngest(
      { gif: b64 },
      { storage: h.storage, publicBaseUrl: PUBLIC_BASE, auth: AUTH, drawingStore: h.drawingStore },
    );
    assert.equal(first.status, 202);
    const firstId = (first.body as { id: string }).id;
    const writesAfterFirst = h.storage.puts.length;

    const second = await handleIngest(
      { gif: b64 },
      { storage: h.storage, publicBaseUrl: PUBLIC_BASE, auth: AUTH, drawingStore: h.drawingStore },
    );
    assert.equal(second.status, 200);
    assert.equal((second.body as { id: string }).id, firstId);
    assert.equal(h.storage.puts.length, writesAfterFirst, "idempotent re-publish should not write again");
  });

  test("re-publish self-heals a missing DDB row without re-writing storage", async () => {
    const h = makeHarness();
    const gif = makeGif(10);
    const id = await contentHashHex(gif);
    // The original publish's row write is non-fatal — simulate it having
    // failed by seeding storage with the gif but leaving the store empty.
    await h.storage.put(`public/tiles/${id}.gif`, gif, "image/gif");
    const putsBefore = h.storage.puts.length;

    const res = await handleIngest(
      { gif: Buffer.from(gif).toString("base64") },
      { storage: h.storage, publicBaseUrl: PUBLIC_BASE, auth: AUTH, drawingStore: h.drawingStore },
    );
    assert.equal(res.status, 200);
    const row = await h.drawingStore.get(id);
    assert.ok(row, "self-heal should have written the missing row");
    assert.equal(row!.username, AUTH.username);
    assert.equal(row!.frames, 1);
    assert.equal(
      h.storage.puts.length,
      putsBefore,
      "self-heal must not regenerate the gif or sidecars",
    );
  });

  test("writes a DrawingRow with user_id + username + size + parent_id from the request", async () => {
    const h = makeHarness();
    const gif = makeGif(2);
    const parentId = "p".repeat(64);
    const res = await handleIngest(
      { gif: Buffer.from(gif).toString("base64"), parent: parentId },
      {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: AUTH,
        drawingStore: h.drawingStore,
        now: () => new Date("2026-06-08T17:30:00.000Z"),
      },
    );
    assert.equal(res.status, 202);
    const id = (res.body as { id: string }).id;
    const row = await h.drawingStore.get(id);
    assert.ok(row, "drawing row should exist");
    assert.equal(row!.user_id, AUTH.user_id);
    assert.equal(row!.username, AUTH.username);
    assert.equal(row!.size, 16);
    assert.equal(row!.parent_id, parentId);
    assert.equal(row!.frames, 1);
    assert.equal(row!.created_at, "2026-06-08T17:30:00.000Z");
  });

  test("identity always comes from cfg.auth, not from anything in the request body", async () => {
    const h = makeHarness();
    const gif = makeGif(3);
    // Stuff bogus identity fields into the body. The TypeScript type
    // doesn't allow them, so cast — that's the whole point: this is
    // the over-the-wire guard for malicious clients.
    const body = {
      gif: Buffer.from(gif).toString("base64"),
      user_id: "attacker",
      username: "attacker",
    } as { gif: string; parent?: string };
    const res = await handleIngest(body, {
      storage: h.storage,
      publicBaseUrl: PUBLIC_BASE,
      auth: AUTH,
      drawingStore: h.drawingStore,
    });
    assert.equal(res.status, 202);
    const id = (res.body as { id: string }).id;
    const row = await h.drawingStore.get(id);
    assert.equal(row!.user_id, AUTH.user_id);
    assert.equal(row!.username, AUTH.username);
  });

  test("parent omitted in the request lands as null on the row (keeps GSI3 sparse)", async () => {
    const h = makeHarness();
    const gif = makeGif(4);
    const res = await handleIngest(
      { gif: Buffer.from(gif).toString("base64") },
      { storage: h.storage, publicBaseUrl: PUBLIC_BASE, auth: AUTH, drawingStore: h.drawingStore },
    );
    assert.equal(res.status, 202);
    const id = (res.body as { id: string }).id;
    const row = await h.drawingStore.get(id);
    assert.equal(row!.parent_id, null);
  });

  test("layers_json is persisted onto the row when supplied", async () => {
    const h = makeHarness();
    const gif = makeGif(20);
    const layersBlob = JSON.stringify({
      v: 1,
      layers: [{ name: "L1", visible: true }, { name: "L2", visible: false }],
      frames: [["aaaa", "bbbb"]],
    });
    const res = await handleIngest(
      { gif: Buffer.from(gif).toString("base64"), layers_json: layersBlob },
      { storage: h.storage, publicBaseUrl: PUBLIC_BASE, auth: AUTH, drawingStore: h.drawingStore },
    );
    assert.equal(res.status, 202);
    const id = (res.body as { id: string }).id;
    const row = await h.drawingStore.get(id);
    assert.equal(row!.layers_json, layersBlob);
  });

  test("oversized layers_json is dropped silently — publish still succeeds", async () => {
    const h = makeHarness();
    const gif = makeGif(21);
    const tooBig = "x".repeat(65 * 1024);
    const res = await handleIngest(
      { gif: Buffer.from(gif).toString("base64"), layers_json: tooBig },
      { storage: h.storage, publicBaseUrl: PUBLIC_BASE, auth: AUTH, drawingStore: h.drawingStore },
    );
    assert.equal(res.status, 202);
    const id = (res.body as { id: string }).id;
    const row = await h.drawingStore.get(id);
    assert.equal(row!.layers_json, undefined);
  });

  test("flat publishes omit layers_json so the attribute stays sparse", async () => {
    const h = makeHarness();
    const gif = makeGif(22);
    const res = await handleIngest(
      { gif: Buffer.from(gif).toString("base64") },
      { storage: h.storage, publicBaseUrl: PUBLIC_BASE, auth: AUTH, drawingStore: h.drawingStore },
    );
    assert.equal(res.status, 202);
    const id = (res.body as { id: string }).id;
    const row = await h.drawingStore.get(id);
    assert.equal(row!.layers_json, undefined);
  });
});

describe("handleIngest body shape validation (#type-safety)", () => {
  // The routes cast parsed JSON straight to IngestRequest, so wrong-typed
  // fields arrive here at runtime despite the compile-time type. Each case
  // must 400 naming the field, before anything reaches storage or DDB.
  const wrongTyped: Array<{ body: unknown; field: string }> = [
    { body: { gif: 123 }, field: "gif" },
    { body: {}, field: "gif" },
    { body: { gif: "aGk=", parent: 123 }, field: "parent" },
    { body: { gif: "aGk=", prompt: 5 }, field: "prompt" },
    { body: { gif: "aGk=", layers_json: {} }, field: "layers_json" },
    { body: [1, 2, 3], field: "body" },
    { body: null, field: "body" },
  ];

  for (const c of wrongTyped) {
    test(`rejects ${JSON.stringify(c.body)} with 400 naming "${c.field}"`, async () => {
      const h = makeHarness();
      const res = await handleIngest(c.body as never, {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: AUTH,
        drawingStore: h.drawingStore,
      });
      assert.equal(res.status, 400);
      assert.equal((res.body as { error: string }).error, `invalid field: ${c.field}`);
      assert.equal(h.storage.puts.length, 0, "nothing may reach storage");
    });
  }
});

describe("deferred post-publish tail", () => {
  test("event guard accepts the self-invoke shape and rejects HTTP events", () => {
    const id = "a".repeat(64);
    const ok = { kind: "post-publish", drawing_id: id, username: "alice", prompt_tagged: false };
    assert.ok(isPostPublishEvent(ok));
    assert.ok(isPostPublishEvent({ ...ok, username: null }), "anonymous publishes carry a null username");
    assert.ok(!isPostPublishEvent({ ...ok, drawing_id: "nope" }));
    assert.ok(!isPostPublishEvent({ ...ok, prompt_tagged: undefined }));
    assert.ok(!isPostPublishEvent({ requestContext: { http: { method: "GET" } } }));
    assert.ok(!isPostPublishEvent(null));
    assert.ok(!isPostPublishEvent("post-publish"));
  });

  test("legacy encode-share-mp4 events are still recognised across a deploy", () => {
    const id = "a".repeat(64);
    assert.ok(isEncodeShareMp4Event({ kind: "encode-share-mp4", drawing_id: id }));
    assert.ok(!isEncodeShareMp4Event({ kind: "encode-share-mp4", drawing_id: "nope" }));
    assert.ok(!isEncodeShareMp4Event(null));
    // The two guards must not claim each other's events.
    assert.ok(!isPostPublishEvent({ kind: "encode-share-mp4", drawing_id: id }));
    assert.ok(
      !isEncodeShareMp4Event({ kind: "post-publish", drawing_id: id, username: null, prompt_tagged: false }),
    );
  });

  test("publish queues the tail instead of doing ANY sidecar work inline", async () => {
    const h = makeHarness();
    const jobs: PostPublishJob[] = [];
    const gif = makeGif(11);
    const res = await handleIngest(
      { gif: Buffer.from(gif).toString("base64") },
      {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: AUTH,
        drawingStore: h.drawingStore,
        deferPostPublish: async (job) => { jobs.push(job); },
      },
    );
    assert.equal(res.status, 202);
    const id = (res.body as { id: string }).id;
    assert.deepEqual(jobs, [{ drawing_id: id, username: AUTH.username, prompt_tagged: false }]);
    // The whole point: the 960x960 encode is ~0.5s and must not be on the
    // response path any more, and neither is the mp4.
    const keys = h.storage.puts.map((p) => p.key);
    assert.deepEqual(keys, [`public/tiles/${id}.gif`], "only the published gif is written inline");
  });

  test("publish does not invalidate CloudFront inline — the tail owns it", async () => {
    const h = makeHarness();
    const inv = new NoopInvalidator();
    await handleIngest(
      { gif: Buffer.from(makeGif(13)).toString("base64") },
      {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: AUTH,
        drawingStore: h.drawingStore,
        cacheInvalidator: inv,
        deferPostPublish: async () => {},
      },
    );
    assert.deepEqual(inv.calls, [], "invalidation belongs to the deferred tail");
  });

  test("an anonymous publish queues a null username so the tail skips /u/", async () => {
    const h = makeHarness();
    const jobs: PostPublishJob[] = [];
    await handleIngest(
      { gif: Buffer.from(makeGif(14)).toString("base64") },
      {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: null,
        drawingStore: h.drawingStore,
        deferPostPublish: async (job) => { jobs.push(job); },
      },
    );
    assert.equal(jobs[0].username, null);
  });

  test("a failing defer falls back to running the tail inline, and still 202s", async () => {
    const h = makeHarness();
    const inv = new NoopInvalidator();
    const res = await handleIngest(
      { gif: Buffer.from(makeGif(12)).toString("base64") },
      {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: AUTH,
        drawingStore: h.drawingStore,
        cacheInvalidator: inv,
        deferPostPublish: async () => { throw new Error("lambda invoke down"); },
      },
    );
    assert.equal(res.status, 202);
    const id = (res.body as { id: string }).id;
    // Slow, but losing the OG image + cache flush entirely would be worse.
    const keys = h.storage.puts.map((p) => p.key);
    assert.ok(keys.includes(`public/tiles/${id}-large.gif`), "sidecar still produced");
    assert.equal(inv.calls.length, 1, "invalidation still happened");
  });

  test("with no defer wired (dev server) the tail runs inline so sidecars exist", async () => {
    const h = makeHarness();
    const res = await handleIngest(
      { gif: Buffer.from(makeGif(15)).toString("base64") },
      {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: AUTH,
        drawingStore: h.drawingStore,
      },
    );
    const id = (res.body as { id: string }).id;
    assert.ok(h.storage.puts.some((p) => p.key === `public/tiles/${id}-large.gif`));
  });

  test("runPostPublish renders the -large.gif from the stored gif and then the mp4", async () => {
    const h = makeHarness();
    const inv = new NoopInvalidator();
    const gif = makeGif(16);
    const id = await contentHashHex(gif);
    await h.storage.put(`public/tiles/${id}.gif`, gif, "image/gif");
    const seen: Uint8Array[] = [];
    await runPostPublish(
      { drawing_id: id, username: "alice", prompt_tagged: true },
      {
        storage: h.storage,
        cacheInvalidator: inv,
        encodeMp4: async (bytes) => { seen.push(bytes); return new Uint8Array([9, 9]); },
      },
    );
    const large = await h.storage.getBytes(`public/tiles/${id}-large.gif`);
    assert.ok(large && large.length > 0, "-large.gif rendered from the published bytes");
    assert.equal(seen.length, 1, "mp4 encoder fed the rendered -large.gif");
    assert.deepEqual(seen[0], large);
    assert.deepEqual(await h.storage.getBytes(`public/tiles/${id}-large.mp4`), new Uint8Array([9, 9]));
    assert.deepEqual(inv.calls, [[
      "/", "/feed/items*", "/gallery*", "/u/alice*", "/feed.rss", "/prompts*",
    ]]);
  });

  test("runPostPublish still invalidates when the source gif is missing", async () => {
    // Sidecar failure must not cost the feed its cache flush.
    const h = makeHarness();
    const inv = new NoopInvalidator();
    await runPostPublish(
      { drawing_id: "c".repeat(64), username: null, prompt_tagged: false },
      { storage: h.storage, cacheInvalidator: inv, encodeMp4: async () => new Uint8Array() },
    );
    assert.equal(inv.calls.length, 1);
    assert.equal(h.storage.puts.length, 0, "no sidecar written without source bytes");
  });

  test("encodeShareMp4FromStorage transcodes the stored -large.gif into the mp4 sidecar", async () => {
    const storage = new MemoryStorage();
    const id = "b".repeat(64);
    const largeBytes = new Uint8Array([1, 2, 3]);
    await storage.put(`public/tiles/${id}-large.gif`, largeBytes, "image/gif");
    const seen: Uint8Array[] = [];
    await encodeShareMp4FromStorage(storage, id, async (gifBytes) => {
      seen.push(gifBytes);
      return new Uint8Array([9, 9]);
    });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], largeBytes);
    const mp4 = await storage.getBytes(`public/tiles/${id}-large.mp4`);
    assert.deepEqual(mp4, new Uint8Array([9, 9]));
  });

  test("encodeShareMp4FromStorage logs (never throws) when the -large.gif is missing", async () => {
    const storage = new MemoryStorage();
    const encodeCalls: number[] = [];
    await encodeShareMp4FromStorage(storage, "c".repeat(64), async () => {
      encodeCalls.push(1);
      return new Uint8Array();
    });
    assert.equal(encodeCalls.length, 0, "encoder must not run without input bytes");
    assert.equal(storage.puts.length, 0);
  });
});

// Mid-day UTC on an OVERRIDES date ("2026-06-01" → "tiny-ghost") so the ET
// calendar day — and therefore the expected prompt — is unambiguous in tests.
const PROMPT_NOW = new Date("2026-06-01T12:00:00.000Z");
const TODAY_SLUG = promptForDate(PROMPT_NOW).slug;
// A real, well-formed slug that just isn't today's pick.
const STALE_SLUG = PROMPTS.find((p) => p.slug !== TODAY_SLUG)!.slug;

describe("handleIngest daily-prompt tagging", () => {
  test("today's slug is stored as prompt_id and invalidation includes /prompts*", async () => {
    const h = makeHarness();
    const jobs: PostPublishJob[] = [];
    const gif = makeGif(5);
    const res = await handleIngest(
      { gif: Buffer.from(gif).toString("base64"), prompt: TODAY_SLUG },
      {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: AUTH,
        drawingStore: h.drawingStore,
        deferPostPublish: async (job) => { jobs.push(job); },
        now: () => PROMPT_NOW,
      },
    );
    assert.equal(res.status, 202);
    const row = await h.drawingStore.get((res.body as { id: string }).id);
    assert.equal(row!.prompt_id, TODAY_SLUG);
    assert.deepEqual(jobs.map((j) => j.prompt_tagged), [true]);
  });

  test("stale or garbage slug never fails the publish and is never stored", async () => {
    const cases: Array<{ seed: number; prompt: string }> = [
      { seed: 6, prompt: STALE_SLUG }, // valid format, wrong day
      { seed: 7, prompt: "Not A Slug!!" }, // fails PROMPT_SLUG_RE
      { seed: 8, prompt: "x".repeat(33) }, // too long for PROMPT_SLUG_RE
    ];
    for (const c of cases) {
      const h = makeHarness();
      const jobs: PostPublishJob[] = [];
      const gif = makeGif(c.seed);
      const res = await handleIngest(
        { gif: Buffer.from(gif).toString("base64"), prompt: c.prompt },
        {
          storage: h.storage,
          publicBaseUrl: PUBLIC_BASE,
          auth: AUTH,
          drawingStore: h.drawingStore,
          deferPostPublish: async (job) => { jobs.push(job); },
          now: () => PROMPT_NOW,
        },
      );
      assert.equal(res.status, 202, `publish should succeed for prompt ${JSON.stringify(c.prompt)}`);
      const row = await h.drawingStore.get((res.body as { id: string }).id);
      assert.ok(row, "drawing row should exist");
      assert.ok(!("prompt_id" in row!), `prompt_id must be absent for ${JSON.stringify(c.prompt)}`);
      assert.deepEqual(
        jobs.map((j) => j.prompt_tagged),
        [false],
        `unexpected prompt tag for ${JSON.stringify(c.prompt)}`,
      );
    }
  });

  test("missing prompt keeps the existing behavior exactly", async () => {
    const h = makeHarness();
    const jobs: PostPublishJob[] = [];
    const gif = makeGif(9);
    const res = await handleIngest(
      { gif: Buffer.from(gif).toString("base64") },
      {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: AUTH,
        drawingStore: h.drawingStore,
        deferPostPublish: async (job) => { jobs.push(job); },
        now: () => PROMPT_NOW,
      },
    );
    assert.equal(res.status, 202);
    const row = await h.drawingStore.get((res.body as { id: string }).id);
    assert.ok(!("prompt_id" in row!), "prompt_id must be absent when no prompt is sent");
    assert.deepEqual(jobs, [
      { drawing_id: (res.body as { id: string }).id, username: AUTH.username, prompt_tagged: false },
    ]);
  });
});

// Hand-edit a Drawbang editor gif to remove its DRAWBANG Application
// Extension sub-block.
function stripDrawbangExtension(bytes: Uint8Array): Uint8Array {
  const decoder = new TextDecoder("ascii");
  let p = 13;
  // Skip Global Color Table.
  const packed = bytes[10];
  const gctSize = 1 << ((packed & 0x07) + 1);
  p += gctSize * 3;
  while (p < bytes.length) {
    if (bytes[p] === 0x21 && bytes[p + 1] === 0xff && bytes[p + 2] === 0x0b) {
      const ident = decoder.decode(bytes.subarray(p + 3, p + 11));
      if (ident === "DRAWBANG") {
        // Skip past the auth-code + sub-blocks until terminator.
        let q = p + 14;
        while (bytes[q] !== 0) q += bytes[q] + 1;
        q += 1; // terminator
        const out = new Uint8Array(bytes.length - (q - p));
        out.set(bytes.subarray(0, p), 0);
        out.set(bytes.subarray(q), p);
        return out;
      }
    }
    p++;
  }
  throw new Error("test fixture: DRAWBANG extension not found in gif");
}

// -- Anonymous publishing ----------------------------------------------------
//
// Publishing without a session is a first-class path, not a degraded one:
// the drawing lands in the feed, likeable and bookmarkable like any other.
// What it must NOT do is manufacture an account — no profile page, no
// per-account streak, no /u/ invalidation.

describe("handleIngest without a session", () => {
  test("publishes under the anonymous sentinel instead of failing", async () => {
    const h = makeHarness();
    const gif = makeGif(21);
    const res = await handleIngest(
      { gif: Buffer.from(gif).toString("base64") },
      {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: null,
        drawingStore: h.drawingStore,
      },
    );
    assert.equal(res.status, 202);
    const id = (res.body as { id: string }).id;
    // Same content-addressing rule as an attributed publish.
    assert.equal(id, await contentHashHex(gif));
    const row = await h.drawingStore.get(id);
    assert.equal(row!.username, ANONYMOUS_USERNAME);
    assert.equal(row!.user_id, ANONYMOUS_USER_ID);
    // The gif is really persisted — the drawing is live, not a stub.
    assert.ok(h.storage.puts.some((p) => p.key === `public/tiles/${id}.gif`));
  });

  test("records no per-account stats for an anonymous publish", async () => {
    const h = makeHarness();
    const stats = new MemoryUserStatsStore();
    const res = await handleIngest(
      { gif: Buffer.from(makeGif(22)).toString("base64") },
      {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: null,
        drawingStore: h.drawingStore,
        userStatsStore: stats,
      },
    );
    assert.equal(res.status, 202);
    // The sentinel user_id is shared by every anonymous publish; crediting
    // it would build a streak that belongs to nobody.
    assert.equal(await stats.get(ANONYMOUS_USER_ID), null);
  });

  test("still records stats when a session IS present", async () => {
    const h = makeHarness();
    const stats = new MemoryUserStatsStore();
    await handleIngest(
      { gif: Buffer.from(makeGif(23)).toString("base64") },
      {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: AUTH,
        drawingStore: h.drawingStore,
        userStatsStore: stats,
      },
    );
    assert.ok(await stats.get(AUTH.user_id), "an attributed publish must still count");
  });

  test("skips the /u/ invalidation path — there's no anonymous profile", async () => {
    const h = makeHarness();
    const inv = new NoopInvalidator();
    await handleIngest(
      { gif: Buffer.from(makeGif(24)).toString("base64") },
      {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: null,
        drawingStore: h.drawingStore,
        cacheInvalidator: inv,
      },
    );
    assert.deepEqual(inv.calls, [["/", "/feed/items*", "/gallery*", "/feed.rss"]]);
  });

  test("anonymous drawings appear in the gallery feed", async () => {
    const h = makeHarness();
    const cfg = {
      storage: h.storage,
      publicBaseUrl: PUBLIC_BASE,
      drawingStore: h.drawingStore,
    };
    await handleIngest({ gif: Buffer.from(makeGif(25)).toString("base64") }, { ...cfg, auth: null });
    await handleIngest({ gif: Buffer.from(makeGif(26)).toString("base64") }, { ...cfg, auth: AUTH });
    const page = await h.drawingStore.queryGallery({ limit: 10 });
    assert.equal(page.items.length, 2);
    assert.deepEqual(
      new Set(page.items.map((r) => r.username)),
      new Set([ANONYMOUS_USERNAME, AUTH.username]),
    );
  });

  test("an anonymous publish can still be remixed from a parent", async () => {
    const h = makeHarness();
    const parent = "a".repeat(64);
    const res = await handleIngest(
      { gif: Buffer.from(makeGif(27)).toString("base64"), parent },
      {
        storage: h.storage,
        publicBaseUrl: PUBLIC_BASE,
        auth: null,
        drawingStore: h.drawingStore,
      },
    );
    const row = await h.drawingStore.get((res.body as { id: string }).id);
    assert.equal(row!.parent_id, parent);
  });
});
