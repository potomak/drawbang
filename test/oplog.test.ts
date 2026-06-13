import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  MAX_BYTES,
  MAX_OPS,
  OpLogRecorder,
  OPLOG_VERSION,
  type Op,
  type OpLog,
  type PxPayload,
} from "../src/editor/oplog.js";

describe("OpLogRecorder — happy path", () => {
  test("collapses a multi-pixel stroke into a single px op with packed triples", () => {
    const r = new OpLogRecorder(1_000);
    r.beginStroke(0, 1_100);
    r.recordPixel(1, 2, 7);
    r.recordPixel(3, 4, 7);
    r.recordPixel(5, 6, 7);
    r.endStroke();

    const log = r.serialize();
    assert.equal(log.v, OPLOG_VERSION);
    assert.equal(log.ops.length, 1);
    assert.equal(log.ops[0].k, "px");
    assert.equal(log.ops[0].f, 0);
    assert.equal(log.ops[0].t, 100);
    assert.deepEqual((log.ops[0].d as PxPayload).pixels, [1, 2, 7, 3, 4, 7, 5, 6, 7]);
    assert.equal(log.truncated, undefined);
  });

  test("an empty stroke (no pixels) emits no op so undos don't leave ghosts", () => {
    const r = new OpLogRecorder(0);
    r.beginStroke(0);
    r.endStroke();
    assert.equal(r.opCount, 0);
  });

  test("records every action kind with the expected shape", () => {
    const r = new OpLogRecorder(0);
    r.recordFill(0, 4, 5, 9, 100);
    r.recordFrameAdd(2, 200);
    r.recordFrameDup(1, 2, 300);
    r.recordFrameDel(2, 400);
    r.recordXform(0, "flip-h", 500);
    r.recordPalette(new Uint8Array([0, 1, 2]), 600);
    r.recordClear(700);
    r.recordSize(16, 32, 800);

    const ops = r.serialize().ops;
    const kinds = ops.map((o) => o.k);
    assert.deepEqual(kinds, ["fill", "fradd", "frdup", "frdel", "xform", "pal", "clear", "size"]);

    const byKind = Object.fromEntries(ops.map((o) => [o.k, o]));
    assert.deepEqual(byKind.fill.d, { x: 4, y: 5, color: 9 });
    assert.deepEqual(byKind.fradd.d, { at: 2 });
    assert.deepEqual(byKind.frdup.d, { from: 1, to: 2 });
    assert.deepEqual(byKind.frdel.d, { at: 2 });
    assert.deepEqual(byKind.xform.d, { op: "flip-h" });
    assert.deepEqual(byKind.pal.d, { palette: [0, 1, 2] });
    assert.deepEqual(byKind.size.d, { from: 16, to: 32 });
    assert.equal(byKind.clear.d, undefined);
  });
});

describe("OpLogRecorder — timestamps", () => {
  test("t is ms relative to reset(), not wall clock", () => {
    const r = new OpLogRecorder(10_000);
    r.recordFill(0, 0, 0, 1, 10_500);
    r.recordFill(0, 1, 1, 1, 12_000);
    const ts = r.serialize().ops.map((o) => o.t);
    assert.deepEqual(ts, [500, 2000]);
  });

  test("reset() rebases the clock so a new session starts at zero", () => {
    const r = new OpLogRecorder(100);
    r.recordFill(0, 0, 0, 1, 600);
    r.reset(1_000);
    r.recordFill(0, 0, 0, 1, 1_200);
    const ops = r.serialize().ops;
    assert.equal(ops.length, 1);
    assert.equal(ops[0].t, 200);
  });

  test("negative times clamp to zero", () => {
    const r = new OpLogRecorder(1_000);
    r.recordFill(0, 0, 0, 1, 900);
    assert.equal(r.serialize().ops[0].t, 0);
  });
});

describe("OpLogRecorder — caps", () => {
  test("once op count crosses MAX_OPS the recorder marks truncated and rejects further ops", () => {
    const r = new OpLogRecorder(0);
    for (let i = 0; i < MAX_OPS + 50; i++) r.recordFill(0, 0, 0, 1, i);
    const log = r.serialize();
    assert.equal(log.truncated, true);
    assert.ok(log.ops.length <= MAX_OPS);
    // Adding a fresh op after truncation is a no-op, not a throw.
    r.recordFill(0, 0, 0, 1, 9_999);
    assert.equal(r.serialize().ops.length, log.ops.length);
  });

  test("byte cap triggers truncation even when op count is far below MAX_OPS", () => {
    const r = new OpLogRecorder(0);
    // ~3000 pixels per stroke ≈ ~24KB; 5 such strokes definitely blow MAX_BYTES.
    for (let s = 0; s < 6 && !r.isTruncated; s++) {
      r.beginStroke(0, 0);
      for (let i = 0; i < 3000; i++) r.recordPixel(i % 64, (i + 7) % 64, i % 16);
      r.endStroke();
    }
    assert.equal(r.isTruncated, true);
    const serialized = JSON.stringify(r.serialize());
    // Conservative upper bound: we never store more than ~MAX_BYTES + one
    // last-op worth of headroom; double it for the wrapping JSON.
    assert.ok(serialized.length <= MAX_BYTES * 2);
  });

  test("isTruncated stays sticky across writes after the first cap hit", () => {
    const r = new OpLogRecorder(0);
    for (let i = 0; i < MAX_OPS + 1; i++) r.recordFill(0, 0, 0, 1, i);
    assert.equal(r.isTruncated, true);
    r.recordFrameAdd(1);
    assert.equal(r.isTruncated, true);
  });

  test("strokes started after truncation never append, even if endStroke arrives later", () => {
    const r = new OpLogRecorder(0);
    // Push enough fills to trip truncation by either cap.
    for (let i = 0; i < MAX_OPS + 10; i++) r.recordFill(0, 0, 0, 1, i);
    assert.equal(r.isTruncated, true);
    const before = r.serialize().ops.length;
    r.beginStroke(0, 10_000);
    r.recordPixel(7, 7, 7);
    r.endStroke();
    assert.equal(r.serialize().ops.length, before);
  });
});

describe("OpLogRecorder — serialize() shape", () => {
  test("serialize() returns a defensive copy — later writes don't mutate the snapshot", () => {
    const r = new OpLogRecorder(0);
    r.recordFill(0, 0, 0, 1, 100);
    const log: OpLog = r.serialize();
    r.recordFill(0, 1, 1, 2, 200);
    assert.equal(log.ops.length, 1);
    assert.equal(r.serialize().ops.length, 2);
  });

  test("untruncated logs omit the `truncated` key so JSON stays small", () => {
    const r = new OpLogRecorder(0);
    r.recordFill(0, 0, 0, 1, 0);
    const log = r.serialize();
    assert.equal(Object.prototype.hasOwnProperty.call(log, "truncated"), false);
  });

  test("ops carry their frame index when applicable", () => {
    const r = new OpLogRecorder(0);
    r.recordXform(2, "rotate", 100);
    const op: Op = r.serialize().ops[0];
    assert.equal(op.f, 2);
  });
});
