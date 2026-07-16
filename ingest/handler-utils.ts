// Shared scaffolding for the toggle-style write handlers (likes,
// bookmarks, follows) and any future handler that follows the same
// envelope: a verified session identity in, a `{status, body}` result
// out, and a try/catch that maps store errors to 4xx replies.

export interface Auth {
  user_id: string;
  username: string;
}

export interface BaseHandlerConfig {
  // Test seam: override the wall clock for deterministic timestamps.
  now?: () => Date;
}

export interface Result {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function ok(): Result {
  return { status: 200, body: { ok: true } };
}

export function err(status: number, message: string): Result {
  return { status, body: { error: message } };
}

// Runtime shape check for JSON request bodies at the route boundary
// (#type-safety). Every Drawbang body field is a string, so a spec just
// maps field → required|optional. Returns the first offending field name
// ("body" when the input isn't a plain object), or null when the shape
// matches — the handler turns that into a 400 naming the field. Plain
// typeof checks on purpose: no schema-library dependency (house rule).
export function shapeError(
  input: unknown,
  spec: Record<string, "required" | "optional">,
): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "body";
  }
  const record = input as Record<string, unknown>;
  for (const [field, presence] of Object.entries(spec)) {
    const value = record[field];
    if (value === undefined) {
      if (presence === "required") return field;
      continue;
    }
    if (typeof value !== "string") return field;
  }
  return null;
}

// Wraps the canonical toggle envelope: run a store action; if it throws
// one of the listed error classes, return the matching 4xx; anything
// else re-throws. Tuple form keeps the call site one expression long
// without a separate mapping table object.
export type HandlerErrorMapping = readonly [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (...args: any[]) => Error,
  number,
  string,
];

export async function toggleAction(
  action: () => Promise<unknown>,
  errors: ReadonlyArray<HandlerErrorMapping>,
): Promise<Result> {
  try {
    await action();
    return ok();
  } catch (e) {
    for (const [cls, status, message] of errors) {
      if (e instanceof cls) return err(status, message);
    }
    throw e;
  }
}
