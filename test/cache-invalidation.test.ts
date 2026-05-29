import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  NoopInvalidator,
  pathsToInvalidateOnPublish,
} from "../ingest/cache-invalidation.js";

test("pathsToInvalidateOnPublish: gallery + that user's profile + feed", () => {
  assert.deepEqual(pathsToInvalidateOnPublish("alice"), [
    "/gallery*",
    "/u/alice*",
    "/feed.rss",
  ]);
});

test("NoopInvalidator records calls; skips empty", async () => {
  const inv = new NoopInvalidator();
  await inv.invalidate([]);
  assert.deepEqual(inv.calls, []);
  await inv.invalidate(["/gallery*", "/feed.rss"]);
  assert.deepEqual(inv.calls, [["/gallery*", "/feed.rss"]]);
});
