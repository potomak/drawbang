import { Bitmap } from "./editor/bitmap.js";

// IndexedDB-backed "My drawings" store. Replaces what Redis provided in the
// legacy app for logged-in users.
const DB_NAME = "drawbang";
const DB_VERSION = 1;
const STORE = "drawings";

export interface StoredDrawing {
  id: string; // local uuid (not a PoW hash)
  created_at: number;
  frames: Uint8Array[]; // flattened pixel arrays
  activePalette: Uint8Array;
  publishedId?: string; // PoW hash once submitted
}

function open(): Promise<IDBDatabase> {
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

export async function save(d: {
  id: string;
  frames: Bitmap[];
  activePalette: Uint8Array;
  publishedId?: string;
}): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put({
    id: d.id,
    created_at: Date.now(),
    frames: d.frames.map((f) => new Uint8Array(f.data)),
    activePalette: new Uint8Array(d.activePalette),
    publishedId: d.publishedId,
  } as StoredDrawing);
  await promisify(tx);
}

export async function load(id: string): Promise<StoredDrawing | undefined> {
  const db = await open();
  const tx = db.transaction(STORE, "readonly");
  const req = tx.objectStore(STORE).get(id);
  const res = await requestToPromise<StoredDrawing | undefined>(req);
  await promisify(tx);
  return res;
}

export async function list(): Promise<StoredDrawing[]> {
  const db = await open();
  const tx = db.transaction(STORE, "readonly");
  const req = tx.objectStore(STORE).index("created_at").getAll();
  const res = await requestToPromise<StoredDrawing[]>(req);
  await promisify(tx);
  return res.sort((a, b) => b.created_at - a.created_at);
}

export async function remove(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await promisify(tx);
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
