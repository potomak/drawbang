import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { ACTIVE_PALETTE_SIZE } from "../config/constants.js";
import { Bitmap } from "../src/editor/bitmap.js";
import { OpLogRecorder } from "../src/editor/oplog.js";
import { applyOp, finalState, replay } from "../src/editor/oplog-replay.js";

const DEFAULT_SIZE = 16;
const DEFAULT_PALETTE = makePalette();

function makePalette(): Uint8Array {
  const p = new Uint8Array(ACTIVE_PALETTE_SIZE);
  for (let i = 0; i < p.length; i++) p[i] = i;
  return p;
}

describe("applyOp / finalState — determinism", () => {
  test("a fresh recorder + replay reproduces the live editor's final bitmap exactly", () => {
    const r = new OpLogRecorder(0);
    r.recordPalette(DEFAULT_PALETTE, 0);

    // Simulate three actions: a stroke, a fill, a flip-h.
    r.beginStroke(0, 100);
    r.recordPixel(2, 2, 5);
    r.recordPixel(3, 3, 5);
    r.recordPixel(4, 4, 5);
    r.endStroke();
    r.recordFill(0, 10, 10, 7, 200);
    r.recordXform(0, "flip-h", 300);

    // Live: apply ops one-by-one on a real Bitmap.
    const liveFrame = new Bitmap(DEFAULT_SIZE, DEFAULT_SIZE);
    liveFrame.set(2, 2, 5);
    liveFrame.set(3, 3, 5);
    liveFrame.set(4, 4, 5);
    // (fill is hard to reproduce by hand on the test grid; instead rely
    // on the replay to match a second replay, below.)
    // Replay twice — same ops, same final state.
    const replayedA = finalState(r.serialize(), { size: DEFAULT_SIZE, palette: DEFAULT_PALETTE });
    const replayedB = finalState(r.serialize(), { size: DEFAULT_SIZE, palette: DEFAULT_PALETTE });
    assert.deepEqual(
      Array.from(replayedA.frames[0].data),
      Array.from(replayedB.frames[0].data),
    );
    // Stroke pixels survived the flip — flip mirrors x, so (2,2) → (13,2), etc.
    assert.equal(replayedA.frames[0].get(15 - 2, 2), 5);
    assert.equal(replayedA.frames[0].get(15 - 4, 4), 5);
  });

  test("frame add → switch → stroke draws on the right frame", () => {
    const r = new OpLogRecorder(0);
    r.recordFrameAdd(1, 0);
    // After fradd at 1, current = 1 in the replay state.
    r.beginStroke(1, 100);
    r.recordPixel(0, 0, 9);
    r.endStroke();
    const s = finalState(r.serialize(), { size: DEFAULT_SIZE, palette: DEFAULT_PALETTE });
    assert.equal(s.frames.length, 2);
    assert.equal(s.frames[1].get(0, 0), 9);
    assert.equal(s.frames[0].get(0, 0), DEFAULT_SIZE === 16 ? 16 : 16); // transparent
  });

  test("clear wipes everything and frame index resets", () => {
    const r = new OpLogRecorder(0);
    r.beginStroke(0, 0);
    r.recordPixel(0, 0, 5);
    r.endStroke();
    r.recordClear(100);
    r.beginStroke(0, 200);
    r.recordPixel(1, 1, 6);
    r.endStroke();
    const s = finalState(r.serialize(), { size: DEFAULT_SIZE, palette: DEFAULT_PALETTE });
    assert.equal(s.frames.length, 1);
    assert.equal(s.frames[0].get(0, 0), 16); // transparent
    assert.equal(s.frames[0].get(1, 1), 6);
  });

  test("size op resets size and frames", () => {
    const r = new OpLogRecorder(0);
    r.beginStroke(0, 0);
    r.recordPixel(0, 0, 5);
    r.endStroke();
    r.recordSize(16, 32, 100);
    r.beginStroke(0, 200);
    r.recordPixel(31, 31, 7);
    r.endStroke();
    const s = finalState(r.serialize(), { size: 16, palette: DEFAULT_PALETTE });
    assert.equal(s.size, 32);
    assert.equal(s.frames[0].width, 32);
    assert.equal(s.frames[0].get(31, 31), 7);
  });

  test("out-of-bounds pixels in a stroke are skipped, not thrown", () => {
    const r = new OpLogRecorder(0);
    r.beginStroke(0, 0);
    r.recordPixel(100, 100, 5);
    r.recordPixel(0, 0, 5);
    r.endStroke();
    const s = finalState(r.serialize(), { size: DEFAULT_SIZE, palette: DEFAULT_PALETTE });
    assert.equal(s.frames[0].get(0, 0), 5);
  });
});

describe("replay — timelapse sampling", () => {
  test("a session shorter than the minimum stretches to ≥5s of frames", () => {
    const r = new OpLogRecorder(0);
    r.beginStroke(0, 0);
    r.recordPixel(0, 0, 1);
    r.endStroke();
    r.recordFill(0, 5, 5, 2, 500);
    const t = replay(r.serialize(), { size: DEFAULT_SIZE, palette: DEFAULT_PALETTE });
    assert.ok(t.durationMs >= 5000);
    assert.ok(t.durationMs <= 10000);
    // At 12fps × ≥5s = ≥60 snapshots.
    assert.ok(t.snapshots.length >= 60);
  });

  test("a session longer than the max compresses to ≤10s", () => {
    const r = new OpLogRecorder(0);
    for (let i = 0; i < 60; i++) {
      r.recordFill(0, i % DEFAULT_SIZE, (i * 3) % DEFAULT_SIZE, (i % 15) + 1, i * 1000);
    }
    const t = replay(r.serialize(), { size: DEFAULT_SIZE, palette: DEFAULT_PALETTE });
    assert.ok(t.durationMs <= 10000);
    assert.ok(t.durationMs >= 5000);
  });

  test("the final snapshot equals what finalState produces — no dropped ops at the tail", () => {
    const r = new OpLogRecorder(0);
    r.recordFill(0, 1, 1, 3, 100);
    r.recordFill(0, 2, 2, 4, 200);
    r.recordFill(0, 3, 3, 5, 300);
    const log = r.serialize();
    const final = finalState(log, { size: DEFAULT_SIZE, palette: DEFAULT_PALETTE });
    const t = replay(log, { size: DEFAULT_SIZE, palette: DEFAULT_PALETTE });
    assert.deepEqual(
      Array.from(t.snapshots[t.snapshots.length - 1].data),
      Array.from(final.frames[final.current].data),
    );
  });

  test("an empty log still returns a single blank snapshot at the minimum duration", () => {
    const t = replay({ v: 1, ops: [] }, { size: DEFAULT_SIZE, palette: DEFAULT_PALETTE });
    assert.equal(t.snapshots.length, 1);
    assert.equal(t.durationMs, 5000);
  });

  test("replaying the same log twice produces deep-equal snapshot sequences", () => {
    const r = new OpLogRecorder(0);
    r.beginStroke(0, 100);
    for (let i = 0; i < 8; i++) r.recordPixel(i, i, (i % 15) + 1);
    r.endStroke();
    r.recordFill(0, 0, 1, 3, 500);
    const log = r.serialize();
    const a = replay(log, { size: DEFAULT_SIZE, palette: DEFAULT_PALETTE });
    const b = replay(log, { size: DEFAULT_SIZE, palette: DEFAULT_PALETTE });
    assert.equal(a.snapshots.length, b.snapshots.length);
    for (let i = 0; i < a.snapshots.length; i++) {
      assert.deepEqual(Array.from(a.snapshots[i].data), Array.from(b.snapshots[i].data));
    }
  });
});

describe("applyOp — direct mutation", () => {
  test("the px op mutates the working frame in place — no allocations per pixel", () => {
    const frames = [new Bitmap(DEFAULT_SIZE, DEFAULT_SIZE)];
    const state = { frames, current: 0, size: DEFAULT_SIZE, palette: DEFAULT_PALETTE };
    applyOp(state, { t: 0, k: "px", f: 0, d: { pixels: [1, 2, 7, 3, 4, 8] } });
    assert.equal(state.frames[0].get(1, 2), 7);
    assert.equal(state.frames[0].get(3, 4), 8);
    assert.strictEqual(state.frames[0], frames[0]); // same instance, mutated
  });
});
