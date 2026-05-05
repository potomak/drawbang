import "fake-indexeddb/auto";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  clearStoredIdentity,
  loadStoredIdentity,
  saveStoredIdentity,
  type StoredIdentity,
} from "../src/identity-store.js";

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
