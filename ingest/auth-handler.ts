import { randomBytes } from "node:crypto";
import { JwtError, signJwt, verifyJwt, type JwtClaims } from "./jwt.js";
import { hashPassword, verifyPassword } from "./password.js";
import {
  EmailTakenError,
  TokenVersionMismatchError,
  UsernameTakenError,
  UserNotFoundError,
  type UserRecord,
  type UserStore,
} from "./user-store.js";
import type { EmailSender } from "./email.js";
import type { DrawingStore } from "./drawing-store.js";
import {
  pathsToInvalidateOnProfileChange,
  type CacheInvalidator,
} from "./cache-invalidation.js";
import { ANONYMOUS_USERNAME, EMAIL_RE, USERNAME_RE } from "../config/constants.js";
import {
  verifyChallenge,
  type ChallengeConfig,
  type ChallengeFailure,
} from "./challenge.js";
import {
  deleteAccountAndDrawings,
  type AccountDeleteConfig,
} from "./account-delete.js";
import type { Storage } from "./storage.js";

// POST /auth/register | /auth/login | /auth/password/forgot | /auth/password/reset.
//
// Identity = email (private, unique) + password. Public handle = username
// (unique, immutable v1) used in /u/<username> URLs. Sessions are stateless
// HS256 JWTs ({ sub: user_id, un: username }); /ingest trusts them without a
// DB read. Password reset is single-use via a token_version claim checked
// against the user row at /auth/password/reset time.

const SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 days
const PASSWORD_RESET_TTL_S = 60 * 60; // 1 hour
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

const RESERVED_USERNAMES = new Set([
  "login", "signup", "password", "account", "u", "d", "t", "c", "days", "keys",
  "gallery", "merch", "products", "canvas", "canvases",
  "tile", "tiles", "identity", "privacy", "share", "feed", "404", "admin",
  "api", "ingest", "state", "drawings", "static", "assets",
  // Sentinel handle for every drawing published without a session, plus
  // the pre-account-system rows scripts/migrate-tiles.ts bucketed there.
  // Reserved here AND as a sentinel row in the drawbang-usernames table,
  // so the registration TransactWriteItems condition blocks anyone trying
  // to claim it and impersonate the anonymous byline.
  ANONYMOUS_USERNAME,
  // Project name — operator-reserved (with a matching sentinel row in
  // drawbang-usernames) so no end user can pretend to be an official
  // Drawbang account.
  "drawbang",
]);

export interface AuthHandlerConfig {
  userStore: UserStore;
  email: EmailSender;
  jwtSecret: string;
  publicBaseUrl: string;
  // Proof-of-work gate for register + forgot-password. Required, not
  // optional: an absent config would silently disable the anti-spam gate,
  // and a misconfiguration should break loudly at wiring time instead of
  // quietly reopening the door.
  challenge: ChallengeConfig;
  now?: () => Date;
  // Required only for the /auth/profile-picture route (needs the drawing
  // for the ownership check + the CF invalidator to refresh the profile
  // after).
  drawingStore?: DrawingStore;
  cacheInvalidator?: CacheInvalidator;
  // Required only for account deletion, which cascades to the account's
  // drawings and their gif/mp4 objects.
  storage?: Storage;
}

export interface AuthResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface RegisterRequest {
  email?: unknown;
  username?: unknown;
  password?: unknown;
  // base64 ALTCHA payload from the widget. Field name matches the widget's
  // default hidden-input name so the client side stays boring.
  altcha?: unknown;
}
interface LoginRequest {
  email?: unknown;
  password?: unknown;
}
interface ForgotPasswordRequest {
  email?: unknown;
  altcha?: unknown;
}
interface ResetPasswordRequest {
  token?: unknown;
  password?: unknown;
}

export interface DeleteAccountRequest {
  password?: unknown;
}

interface PasswordResetClaims extends JwtClaims {
  email: string;
  tv: number;
  purpose: "password-reset";
}

function issueSession(
  user: { user_id: string; username: string },
  cfg: AuthHandlerConfig,
  nowSec: number,
): string {
  return signJwt(
    { sub: user.user_id, un: user.username },
    cfg.jwtSecret,
    SESSION_TTL_S,
    nowSec,
  );
}

function err(status: number, message: string): AuthResult {
  return { status, body: { error: message } };
}

const CHALLENGE_MESSAGES: Record<ChallengeFailure, string> = {
  missing: "verification required — please complete the anti-spam check",
  malformed: "verification payload is invalid — please try again",
  expired: "verification expired — please try again",
  invalid: "verification failed — please try again",
  replayed: "verification already used — please try again",
};

// Runs the proof-of-work gate. Returns null when the caller may proceed,
// or the response to send back. `code` is machine-readable so the client
// knows to fetch a fresh challenge and retry rather than showing a dead
// end — every failure here is recoverable by re-solving.
//
// **400, not 403, and that is not a style choice.** CloudFront's
// CustomErrorResponses map every origin 403 (and 404) to /404.html
// distribution-wide — see infra/aws/template.yaml. A 403 here reaches the
// browser as an HTML 404 page, so the JSON body and `code` are destroyed
// and the client can't tell an expired challenge from a dead route. This
// is the common failure for a LEGITIMATE user (challenge expired while
// they filled the form), so it has to survive the CDN. Verified against
// prod: the origin's 403 arrives as a 404 HTML page, a 400 arrives intact.
async function challengeGate(
  payload: unknown,
  cfg: AuthHandlerConfig,
): Promise<AuthResult | null> {
  const verdict = await verifyChallenge(payload, cfg.challenge);
  if (verdict.ok) return null;
  return {
    status: 400,
    body: {
      error: CHALLENGE_MESSAGES[verdict.reason],
      code: `challenge_${verdict.reason}`,
    },
  };
}

export async function handleRegister(
  req: RegisterRequest,
  cfg: AuthHandlerConfig,
): Promise<AuthResult> {
  const email = normalizeEmail(req.email);
  if (!email) return err(400, "invalid email");
  const username = normalizeUsername(req.username);
  if (!username) return err(400, "invalid username");
  if (RESERVED_USERNAMES.has(username)) return err(400, "username is reserved");
  if (
    typeof req.password !== "string" ||
    req.password.length < MIN_PASSWORD ||
    req.password.length > MAX_PASSWORD
  ) {
    return err(400, `password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`);
  }

  // Gate AFTER the cheap syntactic checks: verifying spends the challenge,
  // so a mistyped password shouldn't cost the user a fresh solve. It still
  // runs before the scrypt hash and every write, so no account can be
  // created without proof of work.
  const gated = await challengeGate(req.altcha, cfg);
  if (gated) return gated;

  const now = (cfg.now ?? (() => new Date()))();
  const nowSec = Math.floor(now.getTime() / 1000);
  const user = {
    email,
    user_id: randomBytes(32).toString("hex"),
    username,
    password_hash: await hashPassword(req.password),
    token_version: 0,
    created_at: now.toISOString(),
  };

  try {
    await cfg.userStore.register(user);
  } catch (e) {
    if (e instanceof EmailTakenError) return err(409, "email already registered");
    if (e instanceof UsernameTakenError) return err(409, "username already taken");
    throw e;
  }

  return {
    status: 201,
    body: {
      token: issueSession(user, cfg, nowSec),
      user_id: user.user_id,
      username: user.username,
    },
  };
}

export async function handleLogin(
  req: LoginRequest,
  cfg: AuthHandlerConfig,
): Promise<AuthResult> {
  const email = normalizeEmail(req.email);
  if (!email || typeof req.password !== "string") {
    return err(401, "invalid email or password");
  }
  const user = await cfg.userStore.getByEmail(email);
  // Always run a hash comparison shape regardless of user existence to avoid a
  // trivially observable timing oracle, then fail with a generic message.
  const ok = user
    ? await verifyPassword(req.password, user.password_hash)
    : await verifyPassword(req.password, "scrypt$AA$AA");
  if (!user || !ok) return err(401, "invalid email or password");

  const nowSec = Math.floor((cfg.now ?? (() => new Date()))().getTime() / 1000);
  return {
    status: 200,
    body: {
      token: issueSession(user, cfg, nowSec),
      user_id: user.user_id,
      username: user.username,
    },
  };
}

export async function handleForgotPassword(
  req: ForgotPasswordRequest,
  cfg: AuthHandlerConfig,
): Promise<AuthResult> {
  // Gate first here, unlike register: everything downstream either does
  // nothing or sends mail via SES, and nothing on this route is worth
  // reaching without proof of work. A 403 leaks nothing about the address
  // — it's decided before the account is looked up at all.
  const gated = await challengeGate(req.altcha, cfg);
  if (gated) return gated;

  const email = normalizeEmail(req.email);
  // Always return 200 — never reveal whether an email is registered.
  const ok: AuthResult = { status: 200, body: { ok: true } };
  if (!email) return ok;
  const user = await cfg.userStore.getByEmail(email);
  if (!user) return ok;

  const nowSec = Math.floor((cfg.now ?? (() => new Date()))().getTime() / 1000);
  const token = signJwt(
    { email: user.email, tv: user.token_version, purpose: "password-reset" },
    cfg.jwtSecret,
    PASSWORD_RESET_TTL_S,
    nowSec,
  );
  const link = `${cfg.publicBaseUrl}/password/reset?token=${encodeURIComponent(token)}`;
  try {
    await cfg.email.sendPasswordReset(user.email, link);
  } catch (e) {
    // Don't leak send failures to the caller; log for operators.
    console.error("[auth] password reset email failed:", e);
  }
  return ok;
}

export async function handleResetPassword(
  req: ResetPasswordRequest,
  cfg: AuthHandlerConfig,
): Promise<AuthResult> {
  if (typeof req.token !== "string") return err(400, "missing reset token");
  if (
    typeof req.password !== "string" ||
    req.password.length < MIN_PASSWORD ||
    req.password.length > MAX_PASSWORD
  ) {
    return err(400, `password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`);
  }

  const nowSec = Math.floor((cfg.now ?? (() => new Date()))().getTime() / 1000);
  let claims: PasswordResetClaims;
  try {
    claims = verifyJwt<PasswordResetClaims>(req.token, cfg.jwtSecret, nowSec);
  } catch (e) {
    if (e instanceof JwtError) return err(400, "reset link is invalid or expired");
    throw e;
  }
  if (claims.purpose !== "password-reset" || typeof claims.email !== "string") {
    return err(400, "reset link is invalid or expired");
  }

  const passwordHash = await hashPassword(req.password);
  try {
    const user = await cfg.userStore.updatePassword(
      claims.email,
      passwordHash,
      claims.tv,
      new Date(nowSec * 1000).toISOString(),
    );
    return {
      status: 200,
      body: {
        token: issueSession(user, cfg, nowSec),
        user_id: user.user_id,
        username: user.username,
      },
    };
  } catch (e) {
    if (e instanceof TokenVersionMismatchError) {
      return err(400, "reset link is invalid or expired");
    }
    throw e;
  }
}

interface SetProfilePictureRequest {
  drawing_id?: unknown;
}

// Authenticated session passed by the route after JWT verification. The
// users table is keyed by email, but the JWT only carries user_id + username
// — so we hop username → email via the usernames table. (No GSI on user_id,
// since getByEmail is the hot path for login + reset.)
export interface SetProfilePictureAuth {
  user_id: string;
  username: string;
}

// POST body: `{ "drawing_id": "<64hex>" }` to set, `{ "drawing_id": null }`
// to clear. Omitting the field is rejected as a 400 — clearing must be
// explicit so a client bug can't silently wipe a profile picture.
export async function handleSetProfilePicture(
  req: SetProfilePictureRequest,
  auth: SetProfilePictureAuth,
  cfg: AuthHandlerConfig,
): Promise<AuthResult> {
  if (!cfg.drawingStore) return err(500, "drawing store not configured");
  if (req.drawing_id === undefined) {
    return err(400, "missing drawing_id (send null to clear)");
  }
  const drawing_id =
    typeof req.drawing_id === "string" && /^[0-9a-f]{64}$/.test(req.drawing_id)
      ? req.drawing_id
      : null;
  if (req.drawing_id !== null && drawing_id === null) {
    return err(400, "invalid drawing_id (expected 64-hex or null)");
  }

  // Resolve the caller's account row from their public handle. The
  // user_id !== auth.user_id branch is defense-in-depth: usernames are
  // immutable in v1 so the row always matches, but if rename ever ships,
  // an old JWT pointing at a freed-up handle now owned by someone else
  // must NOT be allowed to set their profile picture.
  const account = await cfg.userStore.getByUsername(auth.username);
  if (!account || account.user_id !== auth.user_id) {
    return err(401, "authentication required");
  }

  if (drawing_id) {
    // Ownership check: the drawing must exist AND belong to the caller.
    // Anonymous-bucketed drawings can't be claimed by anyone else since
    // "anonymous" is in RESERVED_USERNAMES, so no real account has that
    // username and the equality below always fails for them.
    const drawing = await cfg.drawingStore.get(drawing_id);
    if (!drawing) return err(404, "drawing not found");
    if (drawing.username !== auth.username) {
      return err(403, "not your drawing");
    }
  }

  let updated;
  try {
    updated = await cfg.userStore.setProfilePicture(account.email, drawing_id);
  } catch (e) {
    // Account was deleted between the getByUsername above and the write.
    // Surface as 401 so the client re-authenticates.
    if (e instanceof UserNotFoundError) return err(401, "authentication required");
    throw e;
  }

  // Refresh the profile so the new profile picture appears immediately.
  // Awaited because Lambda freezes the environment as soon as the handler
  // returns — a fire-and-forget request may never be sent. The invalidator
  // catches + logs its own failures, so this can't fail the response.
  // Drawing pages absorb the change on their own short s-maxage TTL
  // (CC_DRAWING_PAGE in render-handlers.ts).
  if (cfg.cacheInvalidator) {
    await cfg.cacheInvalidator.invalidate(
      pathsToInvalidateOnProfileChange(updated.username),
    );
  }

  return {
    status: 200,
    body: {
      username: updated.username,
      profile_picture_drawing_id: updated.profile_picture_drawing_id ?? null,
    },
  };
}

// POST /auth/profile (write) and GET /auth/profile (read) — public bio
// + link the user controls. Same auth shape as setProfilePicture: identity
// comes from the verified JWT, never the body.
export interface ProfileAuth {
  user_id: string;
  username: string;
}

const MAX_BIO_LEN = 256;
const MAX_LINK_LEN = 200;

interface UpdateProfileRequest {
  bio?: unknown;
  link?: unknown;
}

interface ProfileFields {
  bio: string | null;
  link: string | null;
}

function normalizeBio(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (typeof value !== "string") return { ok: false };
  const cleaned = value.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
  // Reject control chars other than newline + tab so a bio can't smuggle
  // formatting or zero-width tricks into the public render.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(cleaned)) return { ok: false };
  if (cleaned.length > MAX_BIO_LEN) return { ok: false };
  return { ok: true, value: cleaned.length === 0 ? null : cleaned };
}

function normalizeLink(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > MAX_LINK_LEN) return { ok: false };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false };
  return { ok: true, value: url.toString() };
}

async function resolveSelf(
  auth: ProfileAuth,
  cfg: AuthHandlerConfig,
): Promise<{ ok: true; account: UserRecord } | { ok: false }> {
  const account = await cfg.userStore.getByUsername(auth.username);
  if (!account || account.user_id !== auth.user_id) return { ok: false };
  return { ok: true, account };
}

export async function handleGetProfile(
  auth: ProfileAuth,
  cfg: AuthHandlerConfig,
): Promise<AuthResult> {
  const resolved = await resolveSelf(auth, cfg);
  if (!resolved.ok) return err(401, "authentication required");
  const account = resolved.account;
  return {
    status: 200,
    body: {
      username: account.username,
      bio: account.bio ?? null,
      link: account.link ?? null,
    },
  };
}

// POST /auth/account/delete — a user deleting their OWN account.
//
// Two properties hold this together:
//
//   - **The target is always the caller.** It comes from resolveSelf() —
//     the verified JWT's user_id + username, cross-checked against the
//     stored row. There is no body field naming an account, so there is
//     nothing to point somewhere else. An operator deleting somebody
//     else's account goes through DELETE /admin/users/{username} instead,
//     deliberately kept as a separate route so this one keeps that
//     property.
//   - **The current password is required** on top of a valid session.
//     Deletion is irreversible, so a leaked or borrowed JWT alone must not
//     be enough.
//
// The account's drawings go with it — see account-delete.ts for what that
// does and does not sweep.
export async function handleDeleteAccount(
  req: DeleteAccountRequest,
  auth: ProfileAuth,
  cfg: AuthHandlerConfig,
): Promise<AuthResult> {
  if (typeof req.password !== "string" || req.password.length === 0) {
    return err(400, "password required to delete the account");
  }
  const resolved = await resolveSelf(auth, cfg);
  if (!resolved.ok) return err(401, "authentication required");
  const account = resolved.account;

  if (!(await verifyPassword(req.password, account.password_hash))) {
    return err(403, "password does not match");
  }

  const cascade = accountDeleteConfig(cfg);
  if (!cascade) return err(500, "account deletion is not configured");

  const outcome = await deleteAccountAndDrawings(account, cascade);
  if (!outcome.ok) return err(outcome.status, outcome.error);
  return { status: 200, body: outcome.report };
}

// DELETE /admin/users/{username} — an operator deleting ANY account.
//
// The allowlist gate lives in routes.ts (same place /admin/data's does),
// so by the time this runs the caller is already known to be an operator.
// No password is required: an operator isn't proving ownership of the
// target, and they don't have its password. The guard against a misclick
// is the typed confirmation in the admin UI, plus the allowlist itself.
export async function handleAdminDeleteAccount(
  username: string,
  cfg: AuthHandlerConfig,
): Promise<AuthResult> {
  const normalized = normalizeUsername(username);
  if (!normalized) return err(400, "invalid username");
  // The sentinel is a byline, not an account — there is no row to delete,
  // and RESERVED_USERNAMES means no real account can ever hold it.
  if (normalized === ANONYMOUS_USERNAME) {
    return err(400, "anonymous is a byline, not an account");
  }

  const account = await cfg.userStore.getByUsername(normalized);
  if (!account) return err(404, "account not found");

  const cascade = accountDeleteConfig(cfg);
  if (!cascade) return err(500, "account deletion is not configured");

  const outcome = await deleteAccountAndDrawings(account, cascade);
  if (!outcome.ok) return err(outcome.status, outcome.error);
  return { status: 200, body: outcome.report };
}

// The cascade needs a drawing store and object storage on top of what the
// rest of the auth routes use. Both are optional on AuthHandlerConfig (the
// other handlers don't need them), so this narrows once instead of at each
// call site.
function accountDeleteConfig(cfg: AuthHandlerConfig): AccountDeleteConfig | null {
  if (!cfg.drawingStore || !cfg.storage) return null;
  return {
    userStore: cfg.userStore,
    drawingStore: cfg.drawingStore,
    storage: cfg.storage,
    cacheInvalidator: cfg.cacheInvalidator,
  };
}

export async function handleUpdateProfile(
  req: UpdateProfileRequest,
  auth: ProfileAuth,
  cfg: AuthHandlerConfig,
): Promise<AuthResult> {
  // Same "explicit clear" rule as setProfilePicture — omitting a field
  // is a 400 so a client bug can't silently wipe an existing value.
  if (req.bio === undefined) return err(400, "missing bio (send empty string to clear)");
  if (req.link === undefined) return err(400, "missing link (send empty string to clear)");
  const bio = normalizeBio(req.bio);
  if (!bio.ok) return err(400, `invalid bio (plain text, max ${MAX_BIO_LEN} chars)`);
  const link = normalizeLink(req.link);
  if (!link.ok) return err(400, "invalid link (must be an http(s) URL)");

  const resolved = await resolveSelf(auth, cfg);
  if (!resolved.ok) return err(401, "authentication required");

  const fields: ProfileFields = { bio: bio.value, link: link.value };
  let updated;
  try {
    updated = await cfg.userStore.updateProfile(resolved.account.email, fields);
  } catch (e) {
    if (e instanceof UserNotFoundError) return err(401, "authentication required");
    throw e;
  }

  // Awaited because Lambda freezes the environment as soon as the handler
  // returns — a fire-and-forget request may never be sent. The invalidator
  // catches + logs its own failures, so this can't fail the response.
  if (cfg.cacheInvalidator) {
    await cfg.cacheInvalidator.invalidate(
      pathsToInvalidateOnProfileChange(updated.username),
    );
  }

  return {
    status: 200,
    body: {
      username: updated.username,
      bio: updated.bio ?? null,
      link: updated.link ?? null,
    },
  };
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) return null;
  return username;
}

export { SESSION_TTL_S, PASSWORD_RESET_TTL_S };
