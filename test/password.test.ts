import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { hashPassword, verifyPassword } from "../ingest/password.js";

describe("password", () => {
  test("verifies the correct password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  });

  test("rejects the wrong password", async () => {
    const stored = await hashPassword("hunter2");
    assert.equal(await verifyPassword("hunter3", stored), false);
  });

  test("produces a distinct salt per hash", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("same", a), true);
    assert.equal(await verifyPassword("same", b), true);
  });

  test("rejects a malformed stored value", async () => {
    assert.equal(await verifyPassword("x", "garbage"), false);
    assert.equal(await verifyPassword("x", "scrypt$onlytwo"), false);
  });
});
