import "fake-indexeddb/auto";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  PUBKEY_MIRROR_KEY,
  clearStoredIdentity,
  loadStoredIdentity,
  saveStoredIdentity,
  type StoredIdentity,
} from "../src/identity-store.js";

// Minimal localStorage stub. Node doesn't ship one; the identity store's
// pubkey mirror (#171) needs it to be synchronous, so a Map-backed shim
// is enough for unit tests.
class LocalStorageShim {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}
(globalThis as unknown as { localStorage: LocalStorageShim }).localStorage = new LocalStorageShim();

const sample: StoredIdentity = {
  jwk_public: { kty: "OKP", crv: "Ed25519", x: "deadbeef" },
  jwk_secret: { kty: "OKP", crv: "Ed25519", x: "deadbeef", d: "cafebabe" },
  pubkey_hex: "ab".repeat(32),
  created_at: 1717171717,
};

test("load returns null when the store is empty", async () => {
  await clearStoredIdentity();
  assert.equal(await loadStoredIdentity(), null);
});

test("save then load round-trips the StoredIdentity record", async () => {
  await clearStoredIdentity();
  await saveStoredIdentity(sample);
  const loaded = await loadStoredIdentity();
  assert.deepEqual(loaded, sample);
});

test("save overwrites the prior identity (single-row store)", async () => {
  await saveStoredIdentity(sample);
  const replacement: StoredIdentity = { ...sample, pubkey_hex: "cd".repeat(32), created_at: 9 };
  await saveStoredIdentity(replacement);
  const loaded = await loadStoredIdentity();
  assert.equal(loaded?.pubkey_hex, "cd".repeat(32));
  assert.equal(loaded?.created_at, 9);
});

test("clear empties the store", async () => {
  await saveStoredIdentity(sample);
  await clearStoredIdentity();
  assert.equal(await loadStoredIdentity(), null);
});

test("saveStoredIdentity mirrors pubkey_hex to localStorage[drawbang:pubkey]", async () => {
  localStorage.removeItem(PUBKEY_MIRROR_KEY);
  await clearStoredIdentity();
  await saveStoredIdentity(sample);
  assert.equal(localStorage.getItem(PUBKEY_MIRROR_KEY), sample.pubkey_hex);
});

test("clearStoredIdentity removes the localStorage mirror", async () => {
  await saveStoredIdentity(sample);
  assert.equal(localStorage.getItem(PUBKEY_MIRROR_KEY), sample.pubkey_hex);
  await clearStoredIdentity();
  assert.equal(localStorage.getItem(PUBKEY_MIRROR_KEY), null);
});

test("loadStoredIdentity self-heals the mirror for users predating #171", async () => {
  // Simulate a user whose identity is in IndexedDB but whose
  // localStorage mirror has been cleared (or never written).
  await clearStoredIdentity();
  await saveStoredIdentity(sample);
  localStorage.removeItem(PUBKEY_MIRROR_KEY);
  // First load after the missing mirror should re-seed it.
  await loadStoredIdentity();
  assert.equal(localStorage.getItem(PUBKEY_MIRROR_KEY), sample.pubkey_hex);
});

test("loadStoredIdentity clears the mirror when the store is empty", async () => {
  await saveStoredIdentity(sample);
  await clearStoredIdentity();
  // Manually set a stale mirror to confirm load wipes it.
  localStorage.setItem(PUBKEY_MIRROR_KEY, "stale");
  await loadStoredIdentity();
  assert.equal(localStorage.getItem(PUBKEY_MIRROR_KEY), null);
});
