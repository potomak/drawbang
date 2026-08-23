import { createHmac } from "node:crypto";
import { createChallenge, randomInt, verifySolution } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import type { Challenge, Solution } from "altcha-lib/types";
import type { ChallengeStore } from "./challenge-store.js";

// Proof-of-work gate for the two unauthenticated auth endpoints that cost
// us something when abused: POST /auth/register (creates accounts) and
// POST /auth/password/forgot (makes SES send mail to an address of the
// caller's choosing — the real hazard, since a bounce spike can get the
// sending identity throttled and break password resets for everyone).
//
// ALTCHA (https://altcha.org), self-hosted: we mint an HMAC-signed
// challenge, the browser brute-forces a counter until the derived key
// matches the required prefix, and we verify. No third-party service, no
// outbound call on the auth path, no cookies or fingerprinting.
//
// NOTE for future sessions: CLAUDE.md lists proof-of-work among the
// removed concepts not to reintroduce "absent intentional discussion".
// This IS that discussion, and it is a narrower scope than the old one —
// the removed PoW gated PUBLISHING, which must stay free and anonymous.
// Don't put a challenge in front of /ingest.

// PBKDF2/SHA-256 on purpose: it's the one algorithm available natively in
// both Node's WebCrypto and every browser we support. Argon2id/scrypt are
// more hardware-resistant but need WASM in the browser.
const ALGORITHM = "PBKDF2/SHA-256";

// Tuning. Solver work is roughly (counter value) x (PBKDF2 cost), so these
// two multiply — changing either changes the difficulty. Measured on this
// runtime, single-threaded (the browser widget uses workers, so a real
// client is at least this fast): mean ~630ms, max ~880ms to solve, and
// ~1ms to verify. Verification is what the Lambda pays on every register,
// so it has to stay negligible; it does because the challenge carries an
// HMAC over the derived key (keySignature), letting verifySolution do one
// HMAC instead of re-deriving.
const COST = 1_000;
const COUNTER_MIN = 1_000;
const COUNTER_MAX = 5_000;

// How long a minted challenge stays solvable. Long enough that a slow
// device (or a user who opens the form and gets distracted) still
// succeeds, short enough to bound the replay-guard table.
export const CHALLENGE_TTL_S = 10 * 60;

export interface ChallengeConfig {
  // Master secret the two HMAC keys are derived from. Wired to JWT_SECRET
  // so there's no new secret to provision — see deriveSecret().
  secret: string;
  challengeStore: ChallengeStore;
  now?: () => Date;
  // Difficulty override. Exists so tests can mint trivially-solvable
  // challenges (a real one costs ~630ms to solve, which would add minutes
  // to a suite that registers accounts as setup) and so difficulty can be
  // retuned without editing constants. There is deliberately NO flag that
  // skips verification — a bypass is the kind of thing that escapes to
  // production.
  difficulty?: { cost: number; counterMin: number; counterMax: number };
}

// Domain-separated subkeys. Deriving instead of adding two more env vars
// keeps deployment to one secret; the labels make it impossible for a
// challenge signature to be confused with a session or reset JWT signed
// by the same master. Trade-off: rotating JWT_SECRET invalidates
// outstanding challenges, which self-heals in CHALLENGE_TTL_S.
function deriveSecret(master: string, label: string): string {
  return createHmac("sha256", master).update(label).digest("hex");
}

function secrets(cfg: ChallengeConfig): {
  signature: string;
  keySignature: string;
} {
  return {
    signature: deriveSecret(cfg.secret, "altcha-challenge-signature"),
    keySignature: deriveSecret(cfg.secret, "altcha-key-signature"),
  };
}

// GET /auth/challenge — public, uncacheable. Handing a challenge to anyone
// who asks is fine: it's the SOLVING that costs, and a challenge is only
// worth anything once (see ChallengeStore).
export async function mintChallenge(cfg: ChallengeConfig): Promise<Challenge> {
  const { signature, keySignature } = secrets(cfg);
  const now = (cfg.now ?? (() => new Date()))();
  const cost = cfg.difficulty?.cost ?? COST;
  const counterMin = cfg.difficulty?.counterMin ?? COUNTER_MIN;
  const counterMax = cfg.difficulty?.counterMax ?? COUNTER_MAX;
  return createChallenge({
    algorithm: ALGORITHM,
    cost,
    counter: randomInt(counterMin, counterMax),
    deriveKey,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_S * 1000),
    hmacSignatureSecret: signature,
    hmacKeySignatureSecret: keySignature,
  });
}

export type ChallengeFailure = "missing" | "malformed" | "expired" | "invalid" | "replayed";

export type ChallengeVerdict = { ok: true } | { ok: false; reason: ChallengeFailure };

interface ClientPayload {
  challenge: Challenge;
  solution: Solution;
}

// The widget submits base64(JSON({challenge, solution})). Decoded by hand
// rather than via altcha-lib's framework helpers so the replay claim can be
// a single atomic conditional write — see the comment in challenge-store.ts.
function parsePayload(raw: unknown): ClientPayload | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as { challenge?: unknown; solution?: unknown };
  if (typeof body.challenge !== "object" || body.challenge === null) return null;
  if (typeof body.solution !== "object" || body.solution === null) return null;
  const challenge = body.challenge as Challenge;
  if (typeof challenge.parameters?.nonce !== "string") return null;
  return { challenge, solution: body.solution as Solution };
}

// Verifies a submitted payload AND spends it. A verdict of ok:true means
// the caller did the work and nobody has used this challenge before.
//
// Order matters: verify the cryptography BEFORE touching the store, so a
// garbage payload can't write rows, and claim only after the solution is
// known-good so a failed attempt doesn't burn the user's challenge.
export async function verifyChallenge(
  raw: unknown,
  cfg: ChallengeConfig
): Promise<ChallengeVerdict> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, reason: "missing" };
  }
  const payload = parsePayload(raw);
  if (!payload) return { ok: false, reason: "malformed" };

  const { signature, keySignature } = secrets(cfg);
  let result;
  try {
    result = await verifySolution({
      challenge: payload.challenge,
      solution: payload.solution,
      deriveKey,
      hmacSignatureSecret: signature,
      hmacKeySignatureSecret: keySignature,
    });
  } catch {
    // A payload crafted to blow up the verifier is an invalid payload, not
    // a 500 — this runs on an unauthenticated public route.
    return { ok: false, reason: "malformed" };
  }
  if (result.expired) return { ok: false, reason: "expired" };
  if (!result.verified) return { ok: false, reason: "invalid" };

  // TTL floor: never write a row already in the past (DynamoDB ignores
  // those, which would silently disable replay protection for that row).
  const nowS = Math.floor((cfg.now ?? (() => new Date()))().getTime() / 1000);
  const expiresAtS = payload.challenge.parameters.expiresAt ?? nowS + CHALLENGE_TTL_S;
  const claimed = await cfg.challengeStore.claim(
    payload.challenge.parameters.nonce,
    Math.max(expiresAtS, nowS + 60)
  );
  if (!claimed) return { ok: false, reason: "replayed" };
  return { ok: true };
}
