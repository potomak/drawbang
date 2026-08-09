import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { solveChallenge } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import {
  CHALLENGE_TTL_S,
  mintChallenge,
  verifyChallenge,
  type ChallengeConfig,
} from "../ingest/challenge.js";
import { MemoryChallengeStore } from "../ingest/challenge-store.js";
import {
  handleForgotPassword,
  handleRegister,
  type AuthHandlerConfig,
} from "../ingest/auth-handler.js";
import { MemoryUserStore } from "../ingest/user-store.js";
import type { EmailSender } from "../ingest/email.js";
import { solvedPayload, testChallengeConfig } from "./support/challenge.js";

// The proof-of-work gate on POST /auth/register and
// POST /auth/password/forgot. The property that matters most is
// single-use: without it a spammer solves once and replays forever, and
// the gate is decoration.

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  return testChallengeConfig(over);
}

class CapturingEmail implements EmailSender {
  links: { to: string; link: string }[] = [];
  async sendPasswordReset(to: string, link: string): Promise<void> {
    this.links.push({ to, link });
  }
}

function authCfg(challenge: ChallengeConfig): {
  cfg: AuthHandlerConfig;
  email: CapturingEmail;
} {
  const email = new CapturingEmail();
  return {
    email,
    cfg: {
      userStore: new MemoryUserStore(),
      email,
      jwtSecret: "challenge-test-secret",
      publicBaseUrl: "https://example.test",
      challenge,
    },
  };
}

describe("verifyChallenge", () => {
  test("accepts a freshly solved challenge", async () => {
    const c = cfg();
    assert.deepEqual(await verifyChallenge(await solvedPayload(c), c), { ok: true });
  });

  test("rejects replay — a solved payload is spendable exactly once", async () => {
    const c = cfg();
    const payload = await solvedPayload(c);
    assert.deepEqual(await verifyChallenge(payload, c), { ok: true });
    assert.deepEqual(await verifyChallenge(payload, c), {
      ok: false,
      reason: "replayed",
    });
  });

  test("rejects a missing payload", async () => {
    const c = cfg();
    for (const empty of [undefined, null, ""]) {
      assert.deepEqual(await verifyChallenge(empty, c), {
        ok: false,
        reason: "missing",
      });
    }
  });

  test("rejects garbage that isn't base64 JSON of the right shape", async () => {
    const c = cfg();
    const junk = [
      "not-base64!!",
      Buffer.from("not json").toString("base64"),
      Buffer.from(JSON.stringify({ nope: 1 })).toString("base64"),
      Buffer.from(JSON.stringify({ challenge: {}, solution: {} })).toString("base64"),
      Buffer.from(JSON.stringify([1, 2, 3])).toString("base64"),
    ];
    for (const raw of junk) {
      const verdict = await verifyChallenge(raw, c);
      assert.equal(verdict.ok, false, `expected rejection for ${raw.slice(0, 24)}`);
    }
  });

  test("rejects a solution signed with a different secret", async () => {
    const attacker = cfg({ secret: "some-other-secret" });
    const payload = await solvedPayload(attacker);
    // Same store, different signing secret — the HMAC over the challenge
    // is what stops a client from minting its own easy challenges.
    assert.deepEqual(await verifyChallenge(payload, cfg()), {
      ok: false,
      reason: "invalid",
    });
  });

  // The proof is solution.derivedKey — verification checks an HMAC over it
  // against the keySignature baked into the signed challenge, and producing
  // that key is exactly the work. `counter` is only the client's bookkeeping
  // and is deliberately not consulted, so don't write a test that tampers
  // with it and expect a rejection.
  test("rejects a forged derived key", async () => {
    const c = cfg();
    const challenge = await mintChallenge(c);
    const solution = await solveChallenge({ challenge, deriveKey });
    assert.ok(solution);
    const forged = {
      ...solution,
      derivedKey: solution.derivedKey.replace(/^../, "ff"),
    };
    const payload = Buffer.from(
      JSON.stringify({ challenge, solution: forged }),
    ).toString("base64");
    assert.deepEqual(await verifyChallenge(payload, c), {
      ok: false,
      reason: "invalid",
    });
  });

  test("rejects a challenge whose difficulty was edited down", async () => {
    // Mint above the test floor so there is something to weaken — at
    // TEST_DIFFICULTY the "cheaper" challenge would be byte-identical.
    const c = cfg({ difficulty: { cost: 50, counterMin: 0, counterMax: 2 } });
    const challenge = await mintChallenge(c);
    const solution = await solveChallenge({ challenge, deriveKey });
    assert.ok(solution);
    // Keep the real signature but weaken the parameters it covers. This is
    // the attack the challenge HMAC exists to stop: a client handing itself
    // a cheaper puzzle.
    const weakened = {
      ...challenge,
      parameters: { ...challenge.parameters, cost: 1 },
    };
    const payload = Buffer.from(
      JSON.stringify({ challenge: weakened, solution }),
    ).toString("base64");
    assert.deepEqual(await verifyChallenge(payload, c), {
      ok: false,
      reason: "invalid",
    });
  });

  test("rejects an expired challenge", async () => {
    const store = new MemoryChallengeStore();
    const mintedAt = new Date("2026-08-09T12:00:00.000Z");
    const minting = cfg({ challengeStore: store, now: () => mintedAt });
    const payload = await solvedPayload(minting);
    // Same challenge, verified one second past its TTL.
    const later = new Date(mintedAt.getTime() + (CHALLENGE_TTL_S + 1) * 1000);
    const verifying = cfg({ challengeStore: store, now: () => later });
    assert.deepEqual(await verifyChallenge(payload, verifying), {
      ok: false,
      reason: "expired",
    });
  });

  test("a rejected payload never spends a challenge id", async () => {
    const store = new MemoryChallengeStore();
    await verifyChallenge("garbage", cfg({ challengeStore: store }));
    assert.equal(store.claimed.size, 0);
  });
});

describe("register is gated on proof of work", () => {
  const body = {
    email: "alice@example.com",
    username: "alice",
    password: "password123",
  };

  test("succeeds with a solved challenge", async () => {
    const h = authCfg(cfg());
    const res = await handleRegister(
      { ...body, altcha: await solvedPayload(h.cfg.challenge) },
      h.cfg,
    );
    assert.equal(res.status, 201);
  });

  test("refuses without one, and creates no account", async () => {
    const h = authCfg(cfg());
    const res = await handleRegister(body, h.cfg);
    assert.equal(res.status, 400);
    assert.equal((res.body as { code: string }).code, "challenge_missing");
    assert.equal(await h.cfg.userStore.getByUsername("alice"), null);
  });

  test("refuses a replayed challenge, so one solve buys one account", async () => {
    const h = authCfg(cfg());
    const payload = await solvedPayload(h.cfg.challenge);
    assert.equal((await handleRegister({ ...body, altcha: payload }, h.cfg)).status, 201);
    const second = await handleRegister(
      { email: "bob@example.com", username: "bob", password: "password123", altcha: payload },
      h.cfg,
    );
    assert.equal(second.status, 400);
    assert.equal((second.body as { code: string }).code, "challenge_replayed");
    assert.equal(await h.cfg.userStore.getByUsername("bob"), null);
  });

  test("field validation runs first, so a typo doesn't burn the solve", async () => {
    const h = authCfg(cfg());
    const store = h.cfg.challenge.challengeStore as MemoryChallengeStore;
    const res = await handleRegister({ ...body, password: "short" }, h.cfg);
    assert.equal(res.status, 400);
    assert.equal(store.claimed.size, 0);
  });
});

describe("forgot-password is gated on proof of work", () => {
  test("refuses without a challenge and sends no mail", async () => {
    const h = authCfg(cfg());
    await handleRegister(
      {
        email: "alice@example.com",
        username: "alice",
        password: "password123",
        altcha: await solvedPayload(h.cfg.challenge),
      },
      h.cfg,
    );
    const res = await handleForgotPassword({ email: "alice@example.com" }, h.cfg);
    assert.equal(res.status, 400);
    assert.equal(h.email.links.length, 0);
  });

  test("keeps the no-enumeration 200 for unknown emails once solved", async () => {
    const h = authCfg(cfg());
    const res = await handleForgotPassword(
      { email: "ghost@example.com", altcha: await solvedPayload(h.cfg.challenge) },
      h.cfg,
    );
    assert.equal(res.status, 200);
    assert.equal(h.email.links.length, 0);
  });
});
