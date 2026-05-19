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

// Sibling flag set by submit.ts after the first successful publish. The
// chrome's identity-link patcher (#171) refuses to upgrade the link to
// /keys/<pubkey> until both this flag and the pubkey mirror are present,
// because /keys/<pubkey>.html doesn't exist on S3 until the daily builder
// has seen at least one drawing from that key. Same try/catch shape as
// the pubkey mirror — Safari private mode is allowed to fail silently.
export const PUBLISHED_FLAG_KEY = "drawbang:has_published";

export function markPublished(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PUBLISHED_FLAG_KEY, "1");
  } catch {
    // private-mode or disabled storage — the patcher falls back to the
    // build-time /identity href, which is the safe default.
  }
}

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
