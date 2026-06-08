import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { handleIngest, type AuthedUser } from "../ingest/handler.js";
import type { Storage } from "../ingest/storage.js";
import { MemoryDrawingStore } from "../ingest/drawing-store.js";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { contentHashHex } from "../src/content-hash.js";

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
});

// Hand-edit a Drawbang editor gif to remove its DRAWBANG Application
// Extension sub-block. Walks until 0x21 0xff (Application Extension),
// checks the 11-byte block matches DRAWBANG, and splices it out.
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
