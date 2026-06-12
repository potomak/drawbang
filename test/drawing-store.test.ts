import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  decodeCursor,
  encodeCursor,
  MemoryDrawingStore,
  type DrawingRow,
} from "../ingest/drawing-store.js";

function row(overrides: Partial<DrawingRow> = {}): DrawingRow {
  const ms = overrides.created_at_ms ?? Date.parse("2026-05-01T12:00:00.000Z");
  return {
    drawing_id: overrides.drawing_id ?? "a".repeat(64),
    size: overrides.size ?? 16,
    created_at: overrides.created_at ?? new Date(ms).toISOString(),
    created_at_ms: ms,
    user_id: overrides.user_id ?? "u".repeat(64),
    username: overrides.username ?? "alice",
    parent_id: overrides.parent_id ?? null,
    // Spread conditionally so unset prompt_id stays absent (sparse GSI4
    // semantics), not an explicit `prompt_id: undefined` key.
    ...(overrides.prompt_id !== undefined ? { prompt_id: overrides.prompt_id } : {}),
    frames: overrides.frames ?? 1,
    gif_size_bytes: overrides.gif_size_bytes ?? 1234,
  };
}

describe("encodeCursor / decodeCursor", () => {
  test("round-trips", () => {
    const c = { created_at_ms: 1_700_000_000_000, drawing_id: "f".repeat(64) };
    const s = encodeCursor(c);
    assert.deepEqual(decodeCursor(s), c);
  });

  test("rejects junk + bad hex", () => {
    assert.equal(decodeCursor(undefined), null);
    assert.equal(decodeCursor(""), null);
    assert.equal(decodeCursor("not-base64!"), null);
    assert.equal(decodeCursor(encodeCursor({ created_at_ms: 1, drawing_id: "short" })), null);
  });
});

describe("MemoryDrawingStore", () => {
  test("put + get roundtrips", async () => {
    const store = new MemoryDrawingStore();
    const r = row();
    await store.put(r);
    const got = await store.get(r.drawing_id);
    assert.deepEqual(got, r);
    assert.equal(await store.get("z".repeat(64)), null);
  });

  test("queryGallery returns newest-first across multiple users", async () => {
    const store = new MemoryDrawingStore();
    const a = row({ drawing_id: "1".repeat(64), created_at_ms: 100, username: "alice", user_id: "alice".padEnd(64, "0") });
    const b = row({ drawing_id: "2".repeat(64), created_at_ms: 200, username: "bob",   user_id: "bob".padEnd(64, "0") });
    const c = row({ drawing_id: "3".repeat(64), created_at_ms: 300, username: "carol", user_id: "carol".padEnd(64, "0") });
    await store.put(a); await store.put(b); await store.put(c);
    const page = await store.queryGallery({ limit: 10 });
    assert.deepEqual(page.items.map((r) => r.drawing_id), [c.drawing_id, b.drawing_id, a.drawing_id]);
    assert.equal(page.next_cursor, null);
  });

  test("queryGallery paginates with a cursor", async () => {
    const store = new MemoryDrawingStore();
    for (let i = 0; i < 5; i++) {
      await store.put(row({
        drawing_id: String(i).padStart(64, "0"),
        created_at_ms: 1000 + i,
      }));
    }
    const page1 = await store.queryGallery({ limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.equal(page1.items[0].created_at_ms, 1004);
    assert.equal(page1.items[1].created_at_ms, 1003);
    assert.ok(page1.next_cursor, "expected a next_cursor");

    const page2 = await store.queryGallery({ limit: 2, cursor: page1.next_cursor! });
    assert.equal(page2.items.length, 2);
    assert.equal(page2.items[0].created_at_ms, 1002);
    assert.equal(page2.items[1].created_at_ms, 1001);

    const page3 = await store.queryGallery({ limit: 2, cursor: page2.next_cursor! });
    assert.equal(page3.items.length, 1);
    assert.equal(page3.items[0].created_at_ms, 1000);
    assert.equal(page3.next_cursor, null);
  });

  test("queryByUsername filters to the given username", async () => {
    const store = new MemoryDrawingStore();
    await store.put(row({ drawing_id: "a".repeat(64), username: "alice", created_at_ms: 100 }));
    await store.put(row({ drawing_id: "b".repeat(64), username: "bob",   created_at_ms: 200 }));
    await store.put(row({ drawing_id: "c".repeat(64), username: "alice", created_at_ms: 300 }));
    const page = await store.queryByUsername("alice", { limit: 10 });
    assert.deepEqual(page.items.map((r) => r.drawing_id), ["c".repeat(64), "a".repeat(64)]);
  });

  test("queryForks filters to forks of a parent", async () => {
    const store = new MemoryDrawingStore();
    const parent = "p".repeat(64);
    await store.put(row({ drawing_id: "1".repeat(64), parent_id: parent, created_at_ms: 100 }));
    await store.put(row({ drawing_id: "2".repeat(64), parent_id: null,   created_at_ms: 200 }));
    await store.put(row({ drawing_id: "3".repeat(64), parent_id: parent, created_at_ms: 300 }));
    const page = await store.queryForks(parent, { limit: 10 });
    assert.deepEqual(page.items.map((r) => r.drawing_id), ["3".repeat(64), "1".repeat(64)]);
  });

  test("put round-trips prompt_id and omits it when unset", async () => {
    const store = new MemoryDrawingStore();
    const tagged = row({ drawing_id: "d".repeat(64), prompt_id: "slime-bounce" });
    const untagged = row({ drawing_id: "e".repeat(64) });
    await store.put(tagged);
    await store.put(untagged);
    assert.equal((await store.get(tagged.drawing_id))?.prompt_id, "slime-bounce");
    const got = await store.get(untagged.drawing_id);
    assert.ok(got, "expected the untagged row back");
    assert.equal("prompt_id" in got, false);
  });

  test("queryByPrompt returns only rows tagged with the prompt, newest-first", async () => {
    const store = new MemoryDrawingStore();
    const prompt = "slime-bounce";
    await store.put(row({ drawing_id: "1".repeat(64), prompt_id: prompt,     created_at_ms: 100 }));
    await store.put(row({ drawing_id: "2".repeat(64),                        created_at_ms: 200 }));
    await store.put(row({ drawing_id: "3".repeat(64), prompt_id: "campfire", created_at_ms: 250 }));
    await store.put(row({ drawing_id: "4".repeat(64), prompt_id: prompt,     created_at_ms: 300 }));
    const page = await store.queryByPrompt(prompt, { limit: 10 });
    assert.deepEqual(page.items.map((r) => r.drawing_id), ["4".repeat(64), "1".repeat(64)]);
    assert.equal(page.next_cursor, null);
  });

  test("queryByPrompt paginates with a cursor", async () => {
    const store = new MemoryDrawingStore();
    const prompt = "coin-spin";
    for (let i = 0; i < 5; i++) {
      await store.put(row({
        drawing_id: String(i).padStart(64, "0"),
        prompt_id: prompt,
        created_at_ms: 1000 + i,
      }));
    }
    // An untagged row newer than the whole set must never leak into a page.
    await store.put(row({ drawing_id: "f".repeat(64), created_at_ms: 9999 }));

    const page1 = await store.queryByPrompt(prompt, { limit: 2 });
    assert.deepEqual(page1.items.map((r) => r.created_at_ms), [1004, 1003]);
    assert.ok(page1.next_cursor, "expected a next_cursor");

    const page2 = await store.queryByPrompt(prompt, { limit: 2, cursor: page1.next_cursor! });
    assert.deepEqual(page2.items.map((r) => r.created_at_ms), [1002, 1001]);

    const page3 = await store.queryByPrompt(prompt, { limit: 2, cursor: page2.next_cursor! });
    assert.deepEqual(page3.items.map((r) => r.created_at_ms), [1000]);
    assert.equal(page3.next_cursor, null);
  });
});
