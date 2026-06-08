// One-JSON-line-per-request outcome log. Every route in lambda.ts /
// dev-server.ts emits exactly one of these alongside its HTTP response,
// so CloudWatch Logs Insights queries like:
//
//   fields @timestamp, route, status, error_code, duration_ms
//   | filter kind = "outcome" and status >= 400
//
// give us the whole 4xx/5xx picture without per-handler grep.
//
// The shape is closed: callers fill the fields they have, the rest stay
// undefined, JSON.stringify drops them. New fields go here first so the
// log shape stays one source of truth.

export interface OutcomeFields {
  requestId: string;
  route: string; // "POST /ingest", "POST /auth/register", "GET /hydrate", …
  status: number;
  duration_ms: number;
  // Identity from the verified JWT (when the route required auth).
  user_id?: string;
  username?: string;
  // Publish-specific.
  drawing_id?: string;
  parent_id?: string | null;
  gif_size_bytes?: number;
  // Error path. error_code is a short stable enum value
  // ("unauthorized" | "bad_json" | "invalid_gif" | "bad_base64" |
  //  "email_taken" | "username_taken" | "validation" | …) so dashboards
  // can group; error_message is the raw human-readable reason capped
  // to keep the log line bounded.
  error_code?: string;
  error_message?: string;
}

const MAX_MESSAGE_LEN = 200;

export function logOutcome(f: OutcomeFields): void {
  const message =
    f.error_message && f.error_message.length > MAX_MESSAGE_LEN
      ? f.error_message.slice(0, MAX_MESSAGE_LEN)
      : f.error_message;
  console.log(JSON.stringify({ kind: "outcome", ...f, error_message: message }));
}

// Map handler.ts's IngestError.body.error → a short stable enum for
// dashboards. New error messages emitted from handler.ts go here too;
// unknown messages default to "other" so we can spot regressions.
export function ingestErrorCode(message: string): string {
  if (message.startsWith("bad base64")) return "bad_base64";
  if (message.startsWith("invalid gif")) return "invalid_gif";
  if (message === "bad json body" || message === "bad json") return "bad_json";
  return "other";
}

// Same idea for the auth subroutes. The set of strings that auth-handler.ts
// returns is small and stable; keep this list in sync when a new err()
// call lands there.
export function authErrorCode(path: string, message: string): string {
  if (message === "authentication required") return "unauthorized";
  if (message === "bad json body" || message === "bad json") return "bad_json";
  if (path === "/auth/register") {
    if (message === "invalid email") return "invalid_email";
    if (message === "invalid username") return "invalid_username";
    if (message === "username is reserved") return "username_reserved";
    if (message.startsWith("password must be")) return "weak_password";
    if (message === "email already registered") return "email_taken";
    if (message === "username already taken") return "username_taken";
  }
  if (path === "/auth/login" && message === "invalid email or password") {
    return "invalid_credentials";
  }
  if (path === "/auth/password/reset") {
    if (message === "missing reset token") return "missing_token";
    if (message === "reset link is invalid or expired") return "invalid_token";
    if (message.startsWith("password must be")) return "weak_password";
  }
  if (path === "/auth/profile-picture") {
    if (message.startsWith("missing drawing_id")) return "missing_drawing_id";
    if (message.startsWith("invalid drawing_id")) return "invalid_drawing_id";
    if (message === "drawing not found") return "drawing_not_found";
    if (message === "not your drawing") return "ownership_mismatch";
    if (message === "drawing store not configured") return "store_unavailable";
  }
  if (path === "/auth/profile") {
    if (message.startsWith("missing bio")) return "missing_bio";
    if (message.startsWith("missing link")) return "missing_link";
    if (message.startsWith("invalid bio")) return "invalid_bio";
    if (message.startsWith("invalid link")) return "invalid_link";
  }
  return "other";
}

// `gif` arrives as base64. 4 b64 chars → 3 bytes, minus padding.
export function estimateBase64Bytes(b64: string): number {
  if (!b64) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}
