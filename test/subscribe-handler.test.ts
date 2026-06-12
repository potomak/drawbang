import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  handleSubscribe,
  type SubscribeHandlerConfig,
} from "../ingest/subscribe-handler.js";
import { MemorySubscribersStore } from "../ingest/subscribers-store.js";

const NOW = new Date("2026-06-12T10:00:00.000Z");

function setup(): { store: MemorySubscribersStore; cfg: SubscribeHandlerConfig } {
  const store = new MemorySubscribersStore();
  return { store, cfg: { subscribersStore: store, now: () => NOW } };
}

describe("handleSubscribe", () => {
  test("valid email subscribes and returns ok", async () => {
    const { store, cfg } = setup();
    const result = await handleSubscribe(
      JSON.stringify({ email: "Sam@Example.com " }),
      cfg,
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true });
    assert.equal(store.emails.get("sam@example.com"), NOW.toISOString());
  });

  test("bad json body is a 400", async () => {
    const { store, cfg } = setup();
    const result = await handleSubscribe("{nope", cfg);
    assert.equal(result.status, 400);
    assert.equal(store.emails.size, 0);
  });

  test("non-object json body is a 400", async () => {
    const { cfg } = setup();
    const result = await handleSubscribe('"hi"', cfg);
    assert.equal(result.status, 400);
  });

  test("invalid email is a 400", async () => {
    const { store, cfg } = setup();
    for (const email of ["", "no-at-sign", "a@b", "a @b.com", "x".repeat(255) + "@example.com"]) {
      const result = await handleSubscribe(JSON.stringify({ email }), cfg);
      assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(email)}`);
    }
    assert.equal(store.emails.size, 0);
  });

  test("filled honeypot returns silent 200 without storing", async () => {
    const { store, cfg } = setup();
    const result = await handleSubscribe(
      JSON.stringify({ email: "bot@example.com", website: "https://spam.example" }),
      cfg,
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true });
    assert.equal(store.emails.size, 0);
  });

  test("empty honeypot field still subscribes", async () => {
    const { store, cfg } = setup();
    const result = await handleSubscribe(
      JSON.stringify({ email: "human@example.com", website: "" }),
      cfg,
    );
    assert.equal(result.status, 200);
    assert.equal(store.emails.size, 1);
  });

  test("duplicate subscribe is idempotent and keeps the original created_at", async () => {
    const { store, cfg } = setup();
    await handleSubscribe(JSON.stringify({ email: "sam@example.com" }), cfg);
    const later = new Date("2026-06-13T10:00:00.000Z");
    const result = await handleSubscribe(JSON.stringify({ email: "sam@example.com" }), {
      ...cfg,
      now: () => later,
    });
    assert.equal(result.status, 200);
    assert.equal(store.emails.size, 1);
    assert.equal(store.emails.get("sam@example.com"), NOW.toISOString());
  });
});
