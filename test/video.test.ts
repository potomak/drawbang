import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  MAX_VIDEO_DURATION_MS,
  MIN_VIDEO_DURATION_MS,
  planVideo,
  VIDEO_PRESETS,
} from "../src/editor/video.js";

describe("planVideo layout", () => {
  test("square preset hits an exact integer scale for every canvas size", () => {
    const expected: Record<number, number> = { 8: 112, 16: 56, 32: 28, 64: 14 };
    for (const [size, scale] of Object.entries(expected)) {
      const plan = planVideo({
        frameCount: 4,
        delayMs: 200,
        size: Number(size),
        preset: "square",
      });
      assert.equal(plan.artScale, scale, `size ${size}`);
      assert.equal(plan.artW, 896, `size ${size} fills the art target exactly`);
      assert.equal(plan.artH, 896);
      assert.equal(plan.width, 1080);
      assert.equal(plan.height, 1080);
      assert.equal(plan.artX, 92);
      assert.equal(plan.artY, 92);
    }
  });

  test("reels preset letterboxes a 1024 art square in 1080×1920", () => {
    const expected: Record<number, number> = { 8: 128, 16: 64, 32: 32, 64: 16 };
    for (const [size, scale] of Object.entries(expected)) {
      const plan = planVideo({
        frameCount: 4,
        delayMs: 200,
        size: Number(size),
        preset: "reels",
      });
      assert.equal(plan.artScale, scale, `size ${size}`);
      assert.equal(plan.artW, 1024);
      assert.equal(plan.width, 1080);
      assert.equal(plan.height, 1920);
      assert.equal(plan.artX, 28);
      assert.equal(plan.artY, 448);
    }
  });

  test("art targets divide evenly by every supported size", () => {
    for (const preset of Object.values(VIDEO_PRESETS)) {
      for (const size of [8, 16, 32, 64]) {
        assert.equal(preset.artTarget % size, 0);
      }
    }
  });
});

describe("planVideo timing", () => {
  test("repeats whole loops until the clip reaches 5s", () => {
    // 8 frames @ 200ms = 1.6s loop → 4 loops = 6.4s.
    const plan = planVideo({ frameCount: 8, delayMs: 200, size: 16, preset: "square" });
    assert.equal(plan.repeats, 4);
    assert.equal(plan.totalFrames, 32);
    assert.equal(plan.durationMs, 6400);
    assert.ok(plan.durationMs >= MIN_VIDEO_DURATION_MS);
    assert.ok(plan.durationMs <= MAX_VIDEO_DURATION_MS);
  });

  test("a single still frame is held for exactly the 5s minimum", () => {
    const plan = planVideo({ frameCount: 1, delayMs: 200, size: 16, preset: "square" });
    assert.equal(plan.repeats, 25);
    assert.equal(plan.durationMs, 5000);
  });

  test("the longest legal loop (16 × 250ms) doubles to 8s", () => {
    const plan = planVideo({ frameCount: 16, delayMs: 250, size: 16, preset: "reels" });
    assert.equal(plan.repeats, 2);
    assert.equal(plan.durationMs, 8000);
  });

  test("the fastest legal loop stays within the cap", () => {
    // 1 frame @ 83ms → 61 repeats ≈ 5.06s.
    const plan = planVideo({ frameCount: 1, delayMs: 83, size: 16, preset: "square" });
    assert.equal(plan.repeats, Math.ceil(5000 / 83));
    assert.ok(plan.durationMs >= MIN_VIDEO_DURATION_MS);
    assert.ok(plan.durationMs <= MAX_VIDEO_DURATION_MS);
  });

  test("a loop already longer than the cap plays exactly once", () => {
    const plan = planVideo({ frameCount: 100, delayMs: 250, size: 16, preset: "square" });
    assert.equal(plan.repeats, 1);
    assert.equal(plan.totalFrames, 100);
  });

  test("fps and per-frame duration derive from delayMs", () => {
    const plan = planVideo({ frameCount: 4, delayMs: 167, size: 16, preset: "square" });
    assert.ok(Math.abs(plan.fps - 1000 / 167) < 1e-9);
    assert.equal(plan.frameDurationUs, 167000);
  });

  test("rejects empty animations and bad delays", () => {
    assert.throws(() => planVideo({ frameCount: 0, delayMs: 200, size: 16, preset: "square" }));
    assert.throws(() => planVideo({ frameCount: 4, delayMs: 0, size: 16, preset: "square" }));
  });
});
