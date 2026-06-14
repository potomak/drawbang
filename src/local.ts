import { Bitmap } from "./editor/bitmap.js";
import {
  newLayerMeta,
  type Frame,
  type LayerMeta,
} from "./editor/layers.js";
import type { OpLog } from "./editor/oplog.js";

// IndexedDB-backed "My drawings" store. Replaces what Redis provided in the
// legacy app for logged-in users.
//
// Record format:
//   v2 (legacy)  — frames: Uint8Array[]                   (one bitmap per frame)
//   v3 (current) — frames: Uint8Array[][] + layers[]      (one bitmap per layer per frame)
//
// The IndexedDB schema version itself stays at 2; only the *record* shape
// changes. Existing v2 records are migrated to v3 on read by wrapping
// each frame as a single-layer stack.
export const DB_NAME = "drawbang";
export const DB_VERSION = 2;
const STORE = "drawings";

export interface StoredLayer {
  id: string;
  name: string;
  visible: boolean;
}

export interface StoredDrawing {
  id: string;
  created_at: number;
  // Per-layer bitmap data, indexed as frames[frameIdx][layerIdx]. Aligns
  // 1:1 with layers[] — layers.length === frames[0].length on every row.
  // Legacy (v2) records carry frames as Uint8Array[] and no layers field;
  // load() / list() migrate them transparently before returning.
  frames: Uint8Array[][];
  // Document-level layer list, bottom→top. Absent on v2 records.
  layers: StoredLayer[];
  activePalette: Uint8Array;
  delayMs?: number; // per-frame delay; absent = legacy 200 ms (5 fps)
  publishedId?: string; // sha256 once published
  // Per-session op log for the timelapse exporter. Absent on legacy
  // drafts and on any draft saved before M8-1 — replay degrades to
  // "not available" rather than throwing.
  opLog?: OpLog;
}

export function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("created_at", "created_at");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface SaveInput {
  id: string;
  // Each Frame.bitmaps.length must equal layers.length (the invariant
  // FrameState already enforces in-memory).
  frames: Frame[];
  layers: LayerMeta[];
  activePalette: Uint8Array;
  delayMs?: number;
  publishedId?: string;
  opLog?: OpLog;
}

export async function save(d: SaveInput): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put({
    id: d.id,
    created_at: Date.now(),
    frames: d.frames.map((f) => f.bitmaps.map((b) => new Uint8Array(b.data))),
    layers: d.layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible })),
    activePalette: new Uint8Array(d.activePalette),
    delayMs: d.delayMs,
    publishedId: d.publishedId,
    opLog: d.opLog,
  } as StoredDrawing);
  await promisify(tx);
}

export async function load(id: string): Promise<StoredDrawing | undefined> {
  const db = await open();
  const tx = db.transaction(STORE, "readonly");
  const req = tx.objectStore(STORE).get(id);
  const raw = await requestToPromise<StoredDrawing | undefined>(req);
  await promisify(tx);
  return raw ? migrate(raw) : undefined;
}

export async function list(): Promise<StoredDrawing[]> {
  const db = await open();
  const tx = db.transaction(STORE, "readonly");
  const req = tx.objectStore(STORE).index("created_at").getAll();
  const res = await requestToPromise<StoredDrawing[]>(req);
  await promisify(tx);
  return res.map(migrate).sort((a, b) => b.created_at - a.created_at);
}

export async function remove(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await promisify(tx);
}

// v2 → v3 migration. v2 stored frames as Uint8Array[] (one bitmap per
// frame) with no layers field. Wrap each frame as a single-layer stack
// and synthesize a default LayerMeta. The migrated record gets written
// back on the next save() — keeping the shim narrow.
export function migrate(raw: StoredDrawing): StoredDrawing {
  const r = raw as unknown as Record<string, unknown>;
  const framesRaw = r.frames as Uint8Array[] | Uint8Array[][] | undefined;
  const isV2 = Array.isArray(framesRaw) && framesRaw[0] instanceof Uint8Array;
  if (!isV2) {
    // Already v3 (or empty). Make sure layers exists for defensive callers.
    if (!Array.isArray(r.layers)) {
      const fallback = newLayerMeta("Layer 1");
      r.layers = [{ id: fallback.id, name: fallback.name, visible: true }];
    }
    return raw;
  }
  const v2Frames = framesRaw as Uint8Array[];
  const meta = newLayerMeta("Layer 1");
  return {
    ...raw,
    frames: v2Frames.map((data) => [data]),
    layers: [{ id: meta.id, name: meta.name, visible: true }],
  };
}

// Reconstructs a list of Frames from a StoredDrawing — convenience for
// the editor's load path. Each cell is wrapped in a Bitmap of the given
// dimensions (the editor passes its current size).
export function framesFromStored(
  stored: StoredDrawing,
  width: number,
  height: number,
): Frame[] {
  return stored.frames.map((perLayer) => ({
    bitmaps: perLayer.map((data) => new Bitmap(width, height, new Uint8Array(data))),
  }));
}

function promisify(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function uuid(): string {
  return crypto.randomUUID();
}
