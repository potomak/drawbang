import { strict as assert } from "node:assert";
import { beforeEach, describe, test } from "node:test";
import {
  handleForgotPassword,
  handleLogin,
  handleRegister,
  handleResetPassword,
  type AuthHandlerConfig,
} from "../ingest/auth-handler.js";
import { MemoryUserStore } from "../ingest/user-store.js";
import { verifyJwt } from "../ingest/jwt.js";
import type { EmailSender } from "../ingest/email.js";

class CapturingEmail implements EmailSender {
  links: { to: string; link: string }[] = [];
  async sendPasswordReset(to: string, link: string): Promise<void> {
    this.links.push({ to, link });
  }
}

const SECRET = "unit-test-secret";

function makeCfg(): { cfg: AuthHandlerConfig; email: CapturingEmail } {
  const email = new CapturingEmail();
  return {
    email,
    cfg: {
      userStore: new MemoryUserStore(),
      email,
      jwtSecret: SECRET,
      publicBaseUrl: "https://example.test",
    },
  };
}

function tokenFromLink(link: string): string {
  return decodeURIComponent(new URL(link).searchParams.get("token") ?? "");
}

describe("auth: register", () => {
  let cfg: AuthHandlerConfig;
  beforeEach(() => {
    cfg = makeCfg().cfg;
  });

  test("creates an account and returns a usable session", async () => {
    const r = await handleRegister(
      { email: "Alice@Example.com", username: "Alice", password: "password123" },
      cfg,
    );
    assert.equal(r.status, 201);
    const body = r.body as { token: string; user_id: string; username: string };
    assert.equal(body.username, "alice");
    assert.match(body.user_id, /^[0-9a-f]{64}$/);
    const claims = verifyJwt(body.token, SECRET);
    assert.equal(claims.sub, body.user_id);
    assert.equal(claims.un, "alice");
  });

  test("rejects duplicate email and username", async () => {
    await handleRegister({ email: "a@b.com", username: "alice", password: "password123" }, cfg);
    const dupEmail = await handleRegister(
      { email: "a@b.com", username: "other", password: "password123" },
      cfg,
    );
    assert.equal(dupEmail.status, 409);
    const dupName = await handleRegister(
      { email: "c@d.com", username: "alice", password: "password123" },
      cfg,
    );
    assert.equal(dupName.status, 409);
  });

  test("validates email, username, password", async () => {
    assert.equal((await handleRegister({ email: "nope", username: "alice", password: "password123" }, cfg)).status, 400);
    assert.equal((await handleRegister({ email: "a@b.com", username: "x", password: "password123" }, cfg)).status, 400);
    assert.equal((await handleRegister({ email: "a@b.com", username: "admin", password: "password123" }, cfg)).status, 400);
    assert.equal((await handleRegister({ email: "a@b.com", username: "alice", password: "short" }, cfg)).status, 400);
  });
});

describe("auth: login", () => {
  test("succeeds with right password, fails otherwise", async () => {
    const cfg = makeCfg().cfg;
    await handleRegister({ email: "a@b.com", username: "alice", password: "password123" }, cfg);

    const ok = await handleLogin({ email: "A@b.com", password: "password123" }, cfg);
    assert.equal(ok.status, 200);

    const wrong = await handleLogin({ email: "a@b.com", password: "nope" }, cfg);
    assert.equal(wrong.status, 401);

    const unknown = await handleLogin({ email: "ghost@b.com", password: "password123" }, cfg);
    assert.equal(unknown.status, 401);
  });
});

describe("auth: password reset", () => {
  test("request always 200; confirm is single-use", async () => {
    const { cfg, email } = makeCfg();
    await handleRegister({ email: "a@b.com", username: "alice", password: "password123" }, cfg);

    // Unknown email still 200, no email sent.
    const ghost = await handleForgotPassword({ email: "ghost@b.com" }, cfg);
    assert.equal(ghost.status, 200);
    assert.equal(email.links.length, 0);

    const req = await handleForgotPassword({ email: "a@b.com" }, cfg);
    assert.equal(req.status, 200);
    assert.equal(email.links.length, 1);
    const token = tokenFromLink(email.links[0].link);

    const confirm = await handleResetPassword({ token, password: "newpassword1" }, cfg);
    assert.equal(confirm.status, 200);

    // Old password no longer works; new one does.
    assert.equal((await handleLogin({ email: "a@b.com", password: "password123" }, cfg)).status, 401);
    assert.equal((await handleLogin({ email: "a@b.com", password: "newpassword1" }, cfg)).status, 200);

    // Reusing the same reset token fails (token_version bumped).
    const replay = await handleResetPassword({ token, password: "anotherpass1" }, cfg);
    assert.equal(replay.status, 400);
  });

  test("rejects a garbage token", async () => {
    const cfg = makeCfg().cfg;
    const r = await handleResetPassword({ token: "not.a.jwt", password: "password123" }, cfg);
    assert.equal(r.status, 400);
  });
});
