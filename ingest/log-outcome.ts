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
  if (message.startsWith("invalid field")) return "invalid_field";
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

// =====================================================================
// Post-publish tail telemetry (kind: "tail").
//
// The tail runs in an async self-invoke with no caller to raise to, so
// for a long time its only trace was free-text console.error on the
// failure path — meaning a SUCCESSFUL run left no record, and a failed
// one couldn't be grouped or counted. Diagnosing "why is this one
// drawing missing its mp4" then required guessing.
//
// One line per tail run, success or failure, answers it directly:
//
//   fields @timestamp, drawing_id, invocation, large_mp4.ok, large_mp4.error
//   | filter kind = "tail" and large_mp4.ok = 0
//   | sort @timestamp desc
//
// and the failure rate over a window is:
//
//   stats count() as runs, sum(large_mp4.ok) as ok by bin(1h)
//   | filter kind = "tail"
// =====================================================================

export interface TailStepLog {
  ok: boolean;
  ms: number;
  // Bytes written, when the step produced an object.
  bytes?: number;
  // Number of paths submitted, for the invalidation step.
  paths?: number;
  error?: string;
}

export interface TailOutcomeFields {
  requestId: string;
  drawing_id: string;
  mode: "publish" | "backfill";
  // Which path ran it. "async" is the self-invoke; "inline" is the
  // fallback in handleIngest and the synchronous targeted backfill.
  invocation: "async" | "inline";
  duration_ms: number;
  large_gif: TailStepLog;
  large_mp4: TailStepLog;
  invalidation: TailStepLog;
  // Lambda ms left when the tail finished. A value near zero on a failed
  // run points at the timeout rather than at the encoder.
  remaining_ms?: number;
}

// ffmpeg stderr is the single most useful artifact when an encode fails,
// and it is chatty — allow more room than the request-outcome cap.
const MAX_TAIL_ERROR_LEN = 800;

function capError(step: TailStepLog): TailStepLog {
  if (!step.error || step.error.length <= MAX_TAIL_ERROR_LEN) return step;
  return { ...step, error: step.error.slice(0, MAX_TAIL_ERROR_LEN) };
}

export function logTailOutcome(f: TailOutcomeFields): void {
  console.log(
    JSON.stringify({
      kind: "tail",
      ...f,
      large_gif: capError(f.large_gif),
      large_mp4: capError(f.large_mp4),
      invalidation: capError(f.invalidation),
    }),
  );
}

// =====================================================================
// Cold-start environment snapshot (kind: "boot"). Emitted once per
// container so questions like "was the ffmpeg binary actually in this
// container?" are one query away instead of a deploy-and-guess loop —
// which is exactly what a missing -large.mp4 investigation needed.
// =====================================================================

export interface BootFields {
  function_name?: string;
  function_version?: string;
  memory_mb?: number;
  node_version: string;
  arch: string;
  ffmpeg_path: string;
  ffmpeg_present: boolean;
  ffmpeg_bytes?: number;
  ffmpeg_executable?: boolean;
}

export function logBoot(f: BootFields): void {
  console.log(JSON.stringify({ kind: "boot", ...f }));
}
