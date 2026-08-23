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
    await assert.rejects(() => s.register(rec({ username: "alice2" })), EmailTakenError);
  });

  test("rejects a duplicate username", async () => {
    const s = new MemoryUserStore();
    await s.register(rec());
    await assert.rejects(() => s.register(rec({ email: "bob@example.com" })), UsernameTakenError);
  });

  test("updatePassword bumps token_version (single use)", async () => {
    const s = new MemoryUserStore();
    await s.register(rec());
    const updated = await s.updatePassword(
      "alice@example.com",
      "scrypt$new$hash",
      0,
      "2026-05-23T01:00:00.000Z"
    );
    assert.equal(updated.token_version, 1);
    assert.equal(updated.password_hash, "scrypt$new$hash");
    // Replaying the same expected version now fails.
    await assert.rejects(
      () => s.updatePassword("alice@example.com", "x", 0, "now"),
      TokenVersionMismatchError
    );
  });

  test("updatePassword on a missing user throws", async () => {
    const s = new MemoryUserStore();
    await assert.rejects(
      () => s.updatePassword("nobody@example.com", "x", 0, "now"),
      TokenVersionMismatchError
    );
  });

  test("listUsers omits the credential fields", async () => {
    const s = new MemoryUserStore();
    await s.register(rec());
    const page = await s.listUsers();
    assert.equal(page.users.length, 1);
    assert.equal(page.truncated, false);
    assert.equal(page.users[0].username, "alice");
    assert.equal(page.users[0].email, "alice@example.com");
    assert.equal("password_hash" in page.users[0], false);
    assert.equal("token_version" in page.users[0], false);
  });

  test("listUsers caps at the limit and reports truncation", async () => {
    const s = new MemoryUserStore();
    for (let i = 0; i < 3; i++) {
      await s.register(
        rec({
          email: `u${i}@example.com`,
          username: `user${i}`,
          user_id: String(i).repeat(64),
        })
      );
    }
    const capped = await s.listUsers({ limit: 2 });
    assert.equal(capped.users.length, 2);
    assert.equal(capped.truncated, true);
    const full = await s.listUsers({ limit: 3 });
    assert.equal(full.users.length, 3);
    assert.equal(full.truncated, false);
  });
});
