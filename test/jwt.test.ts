import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { JwtError, signJwt, verifyJwt } from "../ingest/jwt.js";

const SECRET = "test-secret-please-change";

describe("jwt", () => {
  test("round-trips claims and stamps iat/exp", () => {
    const now = 1_000_000;
    const token = signJwt({ sub: "u1", un: "alice" }, SECRET, 3600, now);
    const claims = verifyJwt(token, SECRET, now);
    assert.equal(claims.sub, "u1");
    assert.equal(claims.un, "alice");
    assert.equal(claims.iat, now);
    assert.equal(claims.exp, now + 3600);
  });

  test("rejects an expired token", () => {
    const iat = 1_000_000;
    const token = signJwt({ sub: "u1" }, SECRET, 100, iat);
    assert.throws(() => verifyJwt(token, SECRET, iat + 101), JwtError);
  });

  test("rejects a wrong secret", () => {
    const token = signJwt({ sub: "u1" }, SECRET, 3600);
    assert.throws(() => verifyJwt(token, "other-secret"), JwtError);
  });

  test("rejects a tampered payload", () => {
    const token = signJwt({ sub: "u1", un: "alice" }, SECRET, 3600);
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "u1", un: "mallory", exp: 9e9 }))
      .toString("base64url");
    assert.throws(() => verifyJwt(`${h}.${forged}.${s}`, SECRET), JwtError);
  });

  test("rejects a malformed token", () => {
    assert.throws(() => verifyJwt("not-a-jwt", SECRET), JwtError);
    assert.throws(() => verifyJwt("a.b", SECRET), JwtError);
  });

  test("rejects a correctly-signed payload that isn't a claims object", () => {
    // signJwt can't produce these shapes, so hand-sign them the same way
    // the module does: HS256 over header.payload with the shared secret.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
      .toString("base64url");
    for (const raw of ["null", "[1,2,3]", '"just-a-string"', "42"]) {
      const payload = Buffer.from(raw).toString("base64url");
      const sig = createHmac("sha256", SECRET)
        .update(`${header}.${payload}`)
        .digest("base64url");
      assert.throws(
        () => verifyJwt(`${header}.${payload}.${sig}`, SECRET),
        JwtError,
        `payload ${raw} must be rejected as a JwtError, not a TypeError`,
      );
    }
  });
});
