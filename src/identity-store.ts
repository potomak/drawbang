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

export async function loadStoredIdentity(): Promise<StoredIdentity | null> {
  const db = await open();
  const tx = db.transaction(IDENTITY_STORE, "readonly");
  const req = tx.objectStore(IDENTITY_STORE).get(KEY);
  const res = await requestToPromise<StoredIdentity | undefined>(req);
  await promisify(tx);
  return res ?? null;
}

export async function saveStoredIdentity(id: StoredIdentity): Promise<void> {
  const db = await open();
  const tx = db.transaction(IDENTITY_STORE, "readwrite");
  tx.objectStore(IDENTITY_STORE).put(id, KEY);
  await promisify(tx);
}

export async function clearStoredIdentity(): Promise<void> {
  const db = await open();
  const tx = db.transaction(IDENTITY_STORE, "readwrite");
  tx.objectStore(IDENTITY_STORE).delete(KEY);
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
