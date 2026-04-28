import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  bytesFromHex,
  exportIdentity,
  generateIdentity,
  importIdentity,
  pubKeyHex,
  signDrawingId,
  verifyDrawingId,
} from "../src/identity.js";
import { contentHash, hashHex } from "../src/pow.js";

const FAKE_GIF = new TextEncoder().encode("not a real gif but bytes will do");

async function makeDrawingIdHex(): Promise<string> {
  return hashHex(await contentHash(FAKE_GIF));
}

test("generate -> sign -> verify (round trip)", async () => {
  const id = await generateIdentity();
  const drawingIdHex = await makeDrawingIdHex();
  const pubHex = await pubKeyHex(id);
  const sigHex = await signDrawingId(id, drawingIdHex);

  assert.match(pubHex, /^[0-9a-f]{64}$/);
  assert.match(sigHex, /^[0-9a-f]{128}$/);
  assert.equal(await verifyDrawingId(pubHex, drawingIdHex, sigHex), true);
});

test("verify fails on a mutated signature", async () => {
  const id = await generateIdentity();
  const drawingIdHex = await makeDrawingIdHex();
  const pubHex = await pubKeyHex(id);
  const sigHex = await signDrawingId(id, drawingIdHex);

  // Flip the first byte
  const tampered = sigHex[0] === "0" ? "1" + sigHex.slice(1) : "0" + sigHex.slice(1);
  assert.equal(await verifyDrawingId(pubHex, drawingIdHex, tampered), false);
});

test("verify fails when the signature is for a different drawing id", async () => {
  const id = await generateIdentity();
  const pubHex = await pubKeyHex(id);
  const drawingA = await makeDrawingIdHex();
  const drawingB = hashHex(await contentHash(new TextEncoder().encode("a different gif")));
  const sig = await signDrawingId(id, drawingA);
  assert.equal(await verifyDrawingId(pubHex, drawingB, sig), false);
});

test("verify fails when checked against a different public key", async () => {
  const a = await generateIdentity();
  const b = await generateIdentity();
  const drawingIdHex = await makeDrawingIdHex();
  const sig = await signDrawingId(a, drawingIdHex);
  const bPub = await pubKeyHex(b);
  assert.equal(await verifyDrawingId(bPub, drawingIdHex, sig), false);
});

test("exportIdentity -> importIdentity round-trips signing capability", async () => {
  const original = await generateIdentity();
  const drawingIdHex = await makeDrawingIdHex();
  const originalPub = await pubKeyHex(original);

  const exported = await exportIdentity(original);
  // JWK must be JSON-serializable (this is what gets downloaded as a file)
  const json = JSON.stringify(exported);
  const parsed = JSON.parse(json);
  const restored = await importIdentity(parsed);

  // Same pubkey after round-trip
  assert.equal(await pubKeyHex(restored), originalPub);

  // Restored secret key still produces verifiable signatures
  const sig = await signDrawingId(restored, drawingIdHex);
  assert.equal(await verifyDrawingId(originalPub, drawingIdHex, sig), true);

  // And the original pubkey can verify a sig made by the restored key
  const sig2 = await signDrawingId(original, drawingIdHex);
  assert.equal(await verifyDrawingId(originalPub, drawingIdHex, sig2), true);
});

test("verifyDrawingId rejects malformed inputs without throwing", async () => {
  const id = await generateIdentity();
  const drawingIdHex = await makeDrawingIdHex();
  const pubHex = await pubKeyHex(id);
  const sigHex = await signDrawingId(id, drawingIdHex);

  assert.equal(await verifyDrawingId("nope", drawingIdHex, sigHex), false);
  assert.equal(await verifyDrawingId(pubHex, "short", sigHex), false);
  assert.equal(await verifyDrawingId(pubHex, drawingIdHex, "nothex"), false);
});

test("bytesFromHex round-trips with hashHex", async () => {
  const drawingIdHex = await makeDrawingIdHex();
  const bytes = bytesFromHex(drawingIdHex);
  assert.equal(bytes.length, 32);
  assert.equal(hashHex(bytes), drawingIdHex);
});
