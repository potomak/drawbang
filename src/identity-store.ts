import { IDENTITY_STORE, open } from "./local.js";

// Single-row identity record persisted in IndexedDB. JWKs round-trip through
// importIdentity/exportIdentity in src/identity.ts and match the format the
// settings dialog (#86) downloads to disk.
export interface StoredIdentity {
  jwk_public: JsonWebKey;
  jwk_secret: JsonWebKey;
  pubkey_hex: string;
  created_at: number;
}

const KEY = "current";

// The canonical store is IndexedDB (above), which is async. The chrome's
// identity-link patcher (#171) needs the pubkey synchronously on first
// paint to avoid an href flash, so we mirror just the pubkey_hex to
// localStorage. Wrapped in try/catch — Safari private mode can throw on
// any localStorage access.
export const PUBKEY_MIRROR_KEY = "drawbang:pubkey";

function writePubkeyMirror(pubkeyHex: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (pubkeyHex) localStorage.setItem(PUBKEY_MIRROR_KEY, pubkeyHex);
    else localStorage.removeItem(PUBKEY_MIRROR_KEY);
  } catch {
    // private-mode or disabled storage — the patcher just falls back to
    // the build-time href, which is acceptable.
  }
}

export async function loadStoredIdentity(): Promise<StoredIdentity | null> {
  const db = await open();
  const tx = db.transaction(IDENTITY_STORE, "readonly");
  const req = tx.objectStore(IDENTITY_STORE).get(KEY);
  const res = await requestToPromise<StoredIdentity | undefined>(req);
  await promisify(tx);
  const result = res ?? null;
  // Self-heal: existing users predate the mirror, so seed it here on
  // every successful load. No-op when the mirror is already correct.
  writePubkeyMirror(result?.pubkey_hex ?? null);
  return result;
}

export async function saveStoredIdentity(id: StoredIdentity): Promise<void> {
  const db = await open();
  const tx = db.transaction(IDENTITY_STORE, "readwrite");
  tx.objectStore(IDENTITY_STORE).put(id, KEY);
  await promisify(tx);
  writePubkeyMirror(id.pubkey_hex);
}

export async function clearStoredIdentity(): Promise<void> {
  const db = await open();
  const tx = db.transaction(IDENTITY_STORE, "readwrite");
  tx.objectStore(IDENTITY_STORE).delete(KEY);
  await promisify(tx);
  writePubkeyMirror(null);
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
