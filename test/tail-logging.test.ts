import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { runPostPublish } from "../ingest/handler.js";
import { NoopInvalidator } from "../ingest/cache-invalidation.js";
import { FsStorage } from "../ingest/storage.js";
import { Bitmap } from "../src/editor/bitmap.js";
import { encodeGif } from "../src/editor/gif.js";
import { DEFAULT_ACTIVE_PALETTE } from "../src/editor/palette.js";
import { contentHashHex } from "../src/content-hash.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The tail's structured log line is the ONLY record an async self-invoke
// leaves behind. When it went missing, diagnosing a single drawing's
// absent -large.mp4 took three deploys of guesswork. These pin the fields
// a future investigation depends on.

function captureLogs(): { lines: unknown[]; restore: () => void } {
  const lines: unknown[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith('{"kind":"tail"')) {
      lines.push(JSON.parse(args[0] as string));
    }
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "drawbang-tail-"));
  const storage = new FsStorage(dir);
  const b = new Bitmap(16, 16);
  for (let i = 0; i < b.data.length; i++) b.data[i] = i % 16;
  const gif = encodeGif({
    frames: [b],
    activePalette: new Uint8Array(DEFAULT_ACTIVE_PALETTE),
    size: 16,
  });
  const id = await contentHashHex(gif);
  await storage.put(`public/tiles/${id}.gif`, gif, "image/gif");
  return { storage, id, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("post-publish tail telemetry", () => {
  test("emits one line per run naming every step, on the SUCCESS path too", async () => {
    // A tail that only logged failures left no way to answer "did it even
    // run for this drawing?" — which was the first question that mattered.
    const h = await harness();
    const cap = captureLogs();
    try {
      await runPostPublish(
        { drawing_id: h.id, username: "alice", prompt_tagged: false, mode: "publish" },
        {
          storage: h.storage,
          cacheInvalidator: new NoopInvalidator(),
          encodeMp4: async () => new Uint8Array([1, 2, 3, 4]),
          log: { requestId: "req-1", invocation: "async" },
        }
      );
    } finally {
      cap.restore();
      await h.cleanup();
    }
    assert.equal(cap.lines.length, 1, "exactly one tail line per run");
    const line = cap.lines[0] as Record<string, never>;
    assert.equal(line.kind, "tail");
    assert.equal(line.drawing_id, h.id);
    assert.equal(line.requestId, "req-1");
    assert.equal(line.invocation, "async");
    assert.equal(line.mode, "publish");
    assert.equal((line.large_gif as { ok: boolean }).ok, true);
    assert.equal((line.large_mp4 as { ok: boolean }).ok, true);
    assert.equal((line.large_mp4 as { bytes: number }).bytes, 4);
    assert.equal((line.invalidation as { ok: boolean }).ok, true);
    assert.equal(typeof line.duration_ms, "number");
  });

  test("a failing encode lands its error text in the line, not just a stack", async () => {
    // ffmpeg's stderr is the single most useful artifact when an encode
    // fails; it has to be queryable, not buried in a console.error.
    const h = await harness();
    const cap = captureLogs();
    try {
      await runPostPublish(
        { drawing_id: h.id, username: null, prompt_tagged: false, mode: "backfill" },
        {
          storage: h.storage,
          cacheInvalidator: new NoopInvalidator(),
          encodeMp4: async () => {
            throw new Error("ffmpeg exit 1: Invalid data found");
          },
          log: { requestId: "req-2", invocation: "inline", remainingMs: () => 4200 },
        }
      );
    } finally {
      cap.restore();
      await h.cleanup();
    }
    const line = cap.lines[0] as Record<string, never>;
    assert.equal((line.large_gif as { ok: boolean }).ok, true, "gif step succeeded");
    assert.equal((line.large_mp4 as { ok: boolean }).ok, false);
    assert.match(String((line.large_mp4 as { error: string }).error), /ffmpeg exit 1/);
    assert.equal(line.mode, "backfill");
    assert.equal(line.invocation, "inline");
    // Distinguishes "the encoder rejected it" from "we ran out of time".
    assert.equal(line.remaining_ms, 4200);
  });

  test("a missing source gif is reported as such, and the mp4 step says it was skipped", async () => {
    const h = await harness();
    const cap = captureLogs();
    try {
      await runPostPublish(
        { drawing_id: "f".repeat(64), username: "alice", prompt_tagged: false },
        {
          storage: h.storage,
          cacheInvalidator: new NoopInvalidator(),
          encodeMp4: async () => new Uint8Array([1]),
          log: { requestId: "req-3", invocation: "async" },
        }
      );
    } finally {
      cap.restore();
      await h.cleanup();
    }
    const line = cap.lines[0] as Record<string, never>;
    assert.equal((line.large_gif as { ok: boolean }).ok, false);
    assert.match(String((line.large_gif as { error: string }).error), /not found/);
    assert.match(String((line.large_mp4 as { error: string }).error), /skipped/);
    assert.equal(line.mode, "publish", "absent mode defaults to publish");
  });

  test("no log context means no line — unit tests and dev stay quiet", async () => {
    const h = await harness();
    const cap = captureLogs();
    try {
      await runPostPublish(
        { drawing_id: h.id, username: "alice", prompt_tagged: false },
        { storage: h.storage, encodeMp4: async () => new Uint8Array([1]) }
      );
    } finally {
      cap.restore();
      await h.cleanup();
    }
    assert.equal(cap.lines.length, 0);
  });

  test("a chatty ffmpeg error is capped so one line can't flood the stream", async () => {
    const h = await harness();
    const cap = captureLogs();
    try {
      await runPostPublish(
        { drawing_id: h.id, username: "alice", prompt_tagged: false },
        {
          storage: h.storage,
          encodeMp4: async () => {
            throw new Error("x".repeat(5000));
          },
          log: { requestId: "req-4", invocation: "async" },
        }
      );
    } finally {
      cap.restore();
      await h.cleanup();
    }
    const line = cap.lines[0] as Record<string, never>;
    const err = String((line.large_mp4 as { error: string }).error);
    assert.ok(err.length <= 800, `capped, got ${err.length}`);
    assert.ok(err.length > 100, "but not truncated to uselessness");
  });
});
