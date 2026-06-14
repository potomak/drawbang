// Op-log recorder: a per-editor-session, append-only journal of the
// authoring actions the user takes. The point isn't undo (the History
// stack covers that) — it's powering a timelapse export of the drawing.
// The replay code lives in M8-2 (oplog-replay.ts); this module is the
// recorder + the on-disk shape.
//
// Shape rules:
//   - `t` is ms since the recorder was reset, so the log is replay-time
//     relative (clock-skew-free).
//   - One `px` op per pointer stroke; pixels are packed into a flat
//     [x, y, color, x, y, color, …] array to keep large strokes tiny.
//   - Other ops (frame add/dup/del, layer add/del/vis/move, transform,
//     palette, clear, size) are one row each and capture only the data
//     needed to re-derive the editor state, not the entire bitmap.
//   - `l` carries the layer index for pixel/fill/xform ops on layered
//     documents. Absent in v1 logs and on flat-document replays;
//     defaults to 0 when missing.
//
// Caps: 5,000 ops OR ~100 KB serialized JSON, whichever comes first.
// Once truncated, the recorder stops accepting ops — the timelapse
// export degrades gracefully ("first N ops shown") rather than
// drifting silently out of sync.

// v2 adds the optional `l` (layer index) field on px/fill/xform ops and
// four new layer ops: ladd/ldel/lvis/lmov. A v1 log replayed by the v2
// engine treats every op as layer 0, which matches the pre-layers world.
export const OPLOG_VERSION = 2;
export const MAX_OPS = 5000;
export const MAX_BYTES = 100 * 1024;

export type OpKind =
  | "px"
  | "fill"
  | "fradd"
  | "frdel"
  | "frdup"
  | "ladd"
  | "ldel"
  | "lvis"
  | "lmov"
  | "xform"
  | "pal"
  | "clear"
  | "size";

export type XformOp = "flip-h" | "flip-v" | "rotate" | "shift-x" | "shift-y";

export interface PxPayload {
  // Packed [x0, y0, color0, x1, y1, color1, …]. `length % 3 === 0`.
  pixels: number[];
}
export interface FillPayload { x: number; y: number; color: number; }
export interface FrameAddPayload { at: number; }
export interface FrameDelPayload { at: number; }
export interface FrameDupPayload { from: number; to: number; }
export interface LayerAddPayload { at: number; }
export interface LayerDelPayload { at: number; }
export interface LayerVisPayload { at: number; visible: boolean; }
export interface LayerMovPayload { from: number; to: number; }
export interface XformPayload { op: XformOp; }
export interface PalPayload { palette: number[]; }
export interface SizePayload { from: number; to: number; }

export type OpPayload =
  | PxPayload
  | FillPayload
  | FrameAddPayload
  | FrameDelPayload
  | FrameDupPayload
  | LayerAddPayload
  | LayerDelPayload
  | LayerVisPayload
  | LayerMovPayload
  | XformPayload
  | PalPayload
  | SizePayload
  | undefined;

export interface Op {
  t: number;
  k: OpKind;
  f?: number;
  // Layer index for px/fill/xform ops on layered documents. Omitted on
  // legacy (v1) ops; replay treats absent as 0 (the only layer).
  l?: number;
  d?: OpPayload;
}

export interface OpLog {
  v: number;
  ops: Op[];
  truncated?: true;
}

export class OpLogRecorder {
  private startedAt = 0;
  private ops: Op[] = [];
  private truncated = false;
  private bytesEstimate = 0;
  private currentStroke:
    | { f: number; l: number; pixels: number[]; tStart: number }
    | null = null;

  constructor(now: number = Date.now()) {
    this.reset(now);
  }

  reset(now: number = Date.now()): void {
    this.startedAt = now;
    this.ops = [];
    this.truncated = false;
    this.bytesEstimate = 0;
    this.currentStroke = null;
  }

  get isTruncated(): boolean {
    return this.truncated;
  }

  get opCount(): number {
    return this.ops.length;
  }

  private rel(now: number): number {
    return Math.max(0, now - this.startedAt);
  }

  private tryPush(op: Op): boolean {
    if (this.truncated) return false;
    const cost = estimateBytes(op);
    if (this.ops.length >= MAX_OPS || this.bytesEstimate + cost > MAX_BYTES) {
      this.truncated = true;
      return false;
    }
    this.ops.push(op);
    this.bytesEstimate += cost;
    return true;
  }

  beginStroke(frameIdx: number, layerIdx: number = 0, now: number = Date.now()): void {
    if (this.truncated) return;
    this.currentStroke = { f: frameIdx, l: layerIdx, pixels: [], tStart: this.rel(now) };
  }

  recordPixel(x: number, y: number, color: number): void {
    if (this.truncated || !this.currentStroke) return;
    this.currentStroke.pixels.push(x, y, color);
  }

  endStroke(): void {
    const s = this.currentStroke;
    this.currentStroke = null;
    if (!s || s.pixels.length === 0) return;
    const op: Op = { t: s.tStart, k: "px", f: s.f, d: { pixels: s.pixels } };
    if (s.l !== 0) op.l = s.l;
    this.tryPush(op);
  }

  recordFill(
    frameIdx: number,
    x: number,
    y: number,
    color: number,
    now: number = Date.now(),
    layerIdx: number = 0,
  ): void {
    const op: Op = { t: this.rel(now), k: "fill", f: frameIdx, d: { x, y, color } };
    if (layerIdx !== 0) op.l = layerIdx;
    this.tryPush(op);
  }

  recordFrameAdd(at: number, now: number = Date.now()): void {
    this.tryPush({ t: this.rel(now), k: "fradd", d: { at } });
  }

  recordFrameDel(at: number, now: number = Date.now()): void {
    this.tryPush({ t: this.rel(now), k: "frdel", d: { at } });
  }

  recordFrameDup(from: number, to: number, now: number = Date.now()): void {
    this.tryPush({ t: this.rel(now), k: "frdup", d: { from, to } });
  }

  recordLayerAdd(at: number, now: number = Date.now()): void {
    this.tryPush({ t: this.rel(now), k: "ladd", d: { at } });
  }

  recordLayerDel(at: number, now: number = Date.now()): void {
    this.tryPush({ t: this.rel(now), k: "ldel", d: { at } });
  }

  recordLayerVisibility(at: number, visible: boolean, now: number = Date.now()): void {
    this.tryPush({ t: this.rel(now), k: "lvis", d: { at, visible } });
  }

  recordLayerMove(from: number, to: number, now: number = Date.now()): void {
    this.tryPush({ t: this.rel(now), k: "lmov", d: { from, to } });
  }

  recordXform(
    frameIdx: number,
    op: XformOp,
    now: number = Date.now(),
    layerIdx: number = 0,
  ): void {
    const entry: Op = { t: this.rel(now), k: "xform", f: frameIdx, d: { op } };
    if (layerIdx !== 0) entry.l = layerIdx;
    this.tryPush(entry);
  }

  recordPalette(palette: Uint8Array, now: number = Date.now()): void {
    this.tryPush({ t: this.rel(now), k: "pal", d: { palette: Array.from(palette) } });
  }

  recordClear(now: number = Date.now()): void {
    this.tryPush({ t: this.rel(now), k: "clear" });
  }

  recordSize(from: number, to: number, now: number = Date.now()): void {
    this.tryPush({ t: this.rel(now), k: "size", d: { from, to } });
  }

  serialize(): OpLog {
    return {
      v: OPLOG_VERSION,
      ops: [...this.ops],
      ...(this.truncated ? { truncated: true as const } : {}),
    };
  }
}

function estimateBytes(op: Op): number {
  // Stringified length is a tight upper bound on what we'll persist in
  // IndexedDB and in any future server payload. Slightly conservative
  // because of escape padding; that's fine for a cap check.
  return JSON.stringify(op).length;
}
