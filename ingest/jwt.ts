import { createHmac, timingSafeEqual } from "node:crypto";

// Minimal HS256 JWT. Hand-rolled to avoid a runtime dependency: the whole
// surface is base64url + HMAC-SHA256 + a constant-time compare + an exp check.
// Sessions are stateless (verified by signature + exp, no DB read); password
// reset links are single-use via a token_version claim checked at the call
// site (see ingest/auth-handler.ts).

export interface JwtClaims {
  iat?: number;
  exp?: number;
  [k: string]: unknown;
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwtError";
  }
}

const HEADER = Buffer.from(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
).toString("base64url");

export function signJwt(
  claims: JwtClaims,
  secret: string,
  expiresInSec: number,
  now: number = nowSec(),
): string {
  const full: JwtClaims = { ...claims, iat: now, exp: now + expiresInSec };
  const payload = Buffer.from(JSON.stringify(full)).toString("base64url");
  const signingInput = `${HEADER}.${payload}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

export function verifyJwt<T extends JwtClaims = JwtClaims>(
  token: string,
  secret: string,
  now: number = nowSec(),
): T {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed token");
  const [header, payload, sig] = parts;
  if (header !== HEADER) throw new JwtError("unexpected header");
  const expected = sign(`${header}.${payload}`, secret);
  const got = Buffer.from(sig);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new JwtError("bad signature");
  }
  let claims: T;
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as T;
  } catch {
    throw new JwtError("bad payload");
  }
  // The payload must be a plain claims object — a signed `null`/array/
  // primitive would otherwise flow out as T (or throw a raw TypeError on
  // the exp read below). Consumer-specific claims (sub, un, purpose, tv)
  // are typeof-guarded at each verify site: extractAuth in lambda.ts /
  // dev-server.ts for sessions, the reset flow in auth-handler.ts.
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    throw new JwtError("bad payload");
  }
  if (typeof claims.exp !== "number" || claims.exp < now) {
    throw new JwtError("token expired");
  }
  return claims;
}

function sign(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
