// Client-side session handling for the email/password account system.
//
// The session is a stateless JWT issued by the ingest Lambda's /auth/* routes.
// We keep it in localStorage and mirror the username to drawbang:username so
// the chrome link patcher (static/chrome-identity.js) can rewrite the nav link
// synchronously before first paint. Publish/claim attach the JWT as a Bearer
// header; the server trusts it without a DB round-trip.

const INGEST_URL = import.meta.env.VITE_INGEST_URL ?? "/ingest";
const AUTH_BASE = INGEST_URL.replace(/\/ingest$/, "");
const JWT_KEY = "drawbang:jwt";
const USERNAME_KEY = "drawbang:username";

export interface Session {
  token: string;
  user_id: string;
  username: string;
  exp: number;
}

interface SessionResponse {
  token: string;
  user_id: string;
  username: string;
}

export type AuthOutcome =
  | { ok: true; session: Session }
  | { ok: false; status: number; error: string };

export type ForgotPasswordOutcome =
  | { ok: true }
  | { ok: false; status: number; error: string };

export function getSession(): Session | null {
  let token: string | null = null;
  try {
    token = localStorage.getItem(JWT_KEY);
  } catch {
    return null;
  }
  if (!token) return null;
  const claims = decodeJwt(token);
  const now = Math.floor(Date.now() / 1000);
  if (
    !claims ||
    typeof claims.sub !== "string" ||
    typeof claims.un !== "string" ||
    typeof claims.exp !== "number" ||
    claims.exp <= now
  ) {
    clearSession();
    return null;
  }
  return { token, user_id: claims.sub, username: claims.un, exp: claims.exp };
}

export function isLoggedIn(): boolean {
  return getSession() !== null;
}

export function authHeader(): Record<string, string> {
  const s = getSession();
  return s ? { Authorization: `Bearer ${s.token}` } : {};
}

export function logout(): void {
  clearSession();
}

export async function register(
  email: string,
  username: string,
  password: string,
): Promise<AuthOutcome> {
  return sessionPost("/auth/register", { email, username, password });
}

export async function login(
  email: string,
  password: string,
): Promise<AuthOutcome> {
  return sessionPost("/auth/login", { email, password });
}

export async function resetPassword(
  token: string,
  password: string,
): Promise<AuthOutcome> {
  return sessionPost("/auth/password/reset", { token, password });
}

export async function forgotPassword(email: string): Promise<ForgotPasswordOutcome> {
  try {
    const res = await fetch(`${AUTH_BASE}/auth/password/forgot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      const data = await safeJson(res);
      return { ok: false, status: res.status, error: data?.error ?? "request failed" };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 0, error: "network error" };
  }
}

async function sessionPost(
  path: string,
  body: Record<string, unknown>,
): Promise<AuthOutcome> {
  try {
    const res = await fetch(`${AUTH_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error ?? "request failed" };
    }
    const payload = data as SessionResponse | null;
    if (!payload || typeof payload.token !== "string") {
      return { ok: false, status: res.status, error: "malformed response" };
    }
    const session = storeSession(payload.token);
    if (!session) {
      return { ok: false, status: res.status, error: "invalid session token" };
    }
    return { ok: true, session };
  } catch {
    return { ok: false, status: 0, error: "network error" };
  }
}

function storeSession(token: string): Session | null {
  try {
    localStorage.setItem(JWT_KEY, token);
  } catch {
    return null;
  }
  const s = getSession();
  if (s) {
    try {
      localStorage.setItem(USERNAME_KEY, s.username);
    } catch {
      // username mirror is best-effort (chrome link patcher); session still valid.
    }
  } else {
    clearSession();
  }
  return s;
}

function clearSession(): void {
  try {
    localStorage.removeItem(JWT_KEY);
    localStorage.removeItem(USERNAME_KEY);
  } catch {
    // ignore storage errors
  }
}

interface JwtPayload {
  sub?: string;
  un?: string;
  exp?: number;
}

function decodeJwt(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = atob(base64urlToBase64(parts[1]));
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

function base64urlToBase64(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return b64 + pad;
}

async function safeJson(res: Response): Promise<{ error?: string } | null> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return null;
  }
}
