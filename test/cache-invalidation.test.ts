import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  NoopInvalidator,
  pathsToInvalidateOnPublish,
} from "../ingest/cache-invalidation.js";

test("pathsToInvalidateOnPublish: home feed + gallery + that user's profile + RSS", () => {
  assert.deepEqual(pathsToInvalidateOnPublish("alice"), [
    "/",
    "/feed/items*",
    "/gallery*",
    "/u/alice*",
    "/feed.rss",
  ]);
});

test("pathsToInvalidateOnPublish: a null username drops the profile path", () => {
  // Anonymous publish — there is no /u/<username> page to flush, and the
  // sentinel must never be interpolated into an invalidation path.
  assert.deepEqual(pathsToInvalidateOnPublish(null), [
    "/",
    "/feed/items*",
    "/gallery*",
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
