import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ageSecondsBetween,
  hashHex,
  leadingZeroBits,
  powHash,
  requiredBits,
  solve,
} from "../src/pow.js";

test("leadingZeroBits counts bits across bytes", () => {
  assert.equal(leadingZeroBits(new Uint8Array([0, 0, 0x01])), 23);
  assert.equal(leadingZeroBits(new Uint8Array([0x80])), 0);
  assert.equal(leadingZeroBits(new Uint8Array([0x00, 0xff])), 8);
  assert.equal(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x00, 0x00])), 32);
});

test("powHash is deterministic across equivalent inputs", async () => {
  const a = await powHash(new Uint8Array([1, 2, 3]), "2025-01-01T00:00:00.000Z", "42");
  const b = await powHash(new Uint8Array([1, 2, 3]), "2025-01-01T00:00:00.000Z", "42");
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.equal(a.length, 32);
});

test("requiredBits picks the right bracket", () => {
  assert.equal(requiredBits(5), 24);
  assert.equal(requiredBits(30), 22);
  assert.equal(requiredBits(90), 20);
  assert.equal(requiredBits(1200), 18);
  assert.equal(requiredBits(7200), 16);
  assert.equal(requiredBits(Number.POSITIVE_INFINITY), 16);
});

test("solve finds a nonce at a low difficulty and the hash matches", async () => {
  const gif = new Uint8Array([0, 1, 2, 3]);
  const baseline = "1970-01-01T00:00:00.000Z";
  const res = await solve(gif, baseline, 8); // ~256 tries
  const hash = await powHash(gif, baseline, res.nonce);
  assert.equal(hashHex(hash), res.hashHex);
  assert.ok(leadingZeroBits(hash) >= 8, `got ${leadingZeroBits(hash)} bits`);
});

test("ageSecondsBetween is positive for now vs earlier baseline", () => {
  const age = ageSecondsBetween("2025-01-01T00:01:00.000Z", "2025-01-01T00:00:00.000Z");
  assert.equal(age, 60);
});
