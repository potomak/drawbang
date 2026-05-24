import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  EmailTakenError,
  MemoryUserStore,
  TokenVersionMismatchError,
  UsernameTakenError,
  type UserRecord,
} from "../ingest/user-store.js";

function rec(over: Partial<UserRecord> = {}): UserRecord {
  return {
    email: "alice@example.com",
    user_id: "a".repeat(64),
    username: "alice",
    password_hash: "scrypt$x$y",
    token_version: 0,
    created_at: "2026-05-23T00:00:00.000Z",
    ...over,
  };
}

describe("MemoryUserStore", () => {
  test("registers and reads back by email", async () => {
    const s = new MemoryUserStore();
    await s.register(rec());
    const got = await s.getByEmail("alice@example.com");
    assert.equal(got?.username, "alice");
    assert.equal(got?.token_version, 0);
  });

  test("rejects a duplicate email", async () => {
    const s = new MemoryUserStore();
    await s.register(rec());
    await assert.rejects(
      () => s.register(rec({ username: "alice2" })),
      EmailTakenError,
    );
  });

  test("rejects a duplicate username", async () => {
    const s = new MemoryUserStore();
    await s.register(rec());
    await assert.rejects(
      () => s.register(rec({ email: "bob@example.com" })),
      UsernameTakenError,
    );
  });

  test("updatePassword bumps token_version (single use)", async () => {
    const s = new MemoryUserStore();
    await s.register(rec());
    const updated = await s.updatePassword(
      "alice@example.com",
      "scrypt$new$hash",
      0,
      "2026-05-23T01:00:00.000Z",
    );
    assert.equal(updated.token_version, 1);
    assert.equal(updated.password_hash, "scrypt$new$hash");
    // Replaying the same expected version now fails.
    await assert.rejects(
      () => s.updatePassword("alice@example.com", "x", 0, "now"),
      TokenVersionMismatchError,
    );
  });

  test("updatePassword on a missing user throws", async () => {
    const s = new MemoryUserStore();
    await assert.rejects(
      () => s.updatePassword("nobody@example.com", "x", 0, "now"),
      TokenVersionMismatchError,
    );
  });
});
