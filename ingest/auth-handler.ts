import { randomBytes } from "node:crypto";
import { JwtError, signJwt, verifyJwt, type JwtClaims } from "./jwt.js";
import { hashPassword, verifyPassword } from "./password.js";
import {
  EmailTakenError,
  TokenVersionMismatchError,
  UsernameTakenError,
  UserNotFoundError,
  type UserStore,
} from "./user-store.js";
import type { EmailSender } from "./email.js";
import type { DrawingStore } from "./drawing-store.js";
import {
  pathsToInvalidateOnProfilePictureChange,
  type CacheInvalidator,
} from "./cache-invalidation.js";

// POST /auth/register | /auth/login | /auth/password/forgot | /auth/password/reset.
//
// Identity = email (private, unique) + password. Public handle = username
// (unique, immutable v1) used in /u/<username> URLs. Sessions are stateless
// HS256 JWTs ({ sub: user_id, un: username }); /ingest trusts them without a
// DB read. Password reset is single-use via a token_version claim checked
// against the user row at /auth/password/reset time.

const SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 days
const PASSWORD_RESET_TTL_S = 60 * 60; // 1 hour
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_]$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

const RESERVED_USERNAMES = new Set([
  "login", "signup", "password", "account", "u", "d", "t", "c", "days", "keys",
  "gallery", "merch", "products", "canvas", "canvases",
  "tile", "tiles", "identity", "privacy", "share", "feed", "404", "admin",
  "api", "ingest", "state", "drawings", "static", "assets",
  // Sentinel handle used by scripts/migrate-tiles.ts to bucket every
  // pre-account-system drawing into /u/anonymous. Also reserved as a
  // sentinel row in the drawbang-usernames table so the registration
  // TransactWriteItems condition blocks anyone trying to claim it.
  "anonymous",
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
  now?: () => Date;
  // Required only for the /auth/profile-picture route (needs the drawing
  // for the ownership check + the CF invalidator to refresh the profile
  // after).
  drawingStore?: DrawingStore;
  cacheInvalidator?: CacheInvalidator;
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
}
interface LoginRequest {
  email?: unknown;
  password?: unknown;
}
interface ForgotPasswordRequest {
  email?: unknown;
}
interface ResetPasswordRequest {
  token?: unknown;
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
    updated = await cfg.userStore.setAvatar(account.email, drawing_id);
  } catch (e) {
    // Account was deleted between the getByUsername above and the write.
    // Surface as 401 so the client re-authenticates.
    if (e instanceof UserNotFoundError) return err(401, "authentication required");
    throw e;
  }

  // Fire-and-forget: refresh the profile so the new profile picture
  // appears immediately. Drawing pages absorb the change on their own
  // short s-maxage TTL (CC_DRAWING_PAGE in render-handlers.ts).
  if (cfg.cacheInvalidator) {
    void cfg.cacheInvalidator.invalidate(
      pathsToInvalidateOnProfilePictureChange(updated.username),
    );
  }

  return {
    status: 200,
    body: {
      username: updated.username,
      profile_picture_drawing_id: updated.avatar_drawing_id ?? null,
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
