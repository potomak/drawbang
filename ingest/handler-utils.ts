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
