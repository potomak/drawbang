import { AUTH_BASE } from "./auth.js";

// Client half of the proof-of-work gate on account creation and
// forgot-password (server half: ingest/challenge.ts). The widget is
// ALTCHA's web component: it fetches a signed challenge from
// GET /auth/challenge, brute-forces it in a worker, and hands back a
// base64 payload we post alongside the form fields.
//
// Loaded dynamically. The editor's publish dialog can register an account
// too, and most people who open /draw never do — a static import would put
// the widget in the editor's initial bundle for everyone.

export type AltchaWidget = HTMLElement & {
  verify(): Promise<{ payload?: string } | null>;
  reset(): void;
};

export class ChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChallengeError";
  }
}

let loading: Promise<void> | null = null;

// Idempotent: safe to call from several controllers on the same page.
export function loadAltcha(): Promise<void> {
  loading ??= import("altcha").then(() => {
    // The widget markup is static HTML, but the API origin is a build-time
    // env var, so the challenge URL has to be set from script.
    globalThis.$altcha?.defaults.set({ challenge: `${AUTH_BASE}/auth/challenge` });
  });
  return loading;
}

// Solves a FRESH challenge every call. Deliberately not cached: the server
// spends a payload the first time it verifies, so reusing one across two
// submits (a taken username, then a retry) would come back as a replay.
export async function solveChallenge(widget: AltchaWidget | null): Promise<string> {
  if (!widget) throw new ChallengeError("anti-spam check is unavailable");
  await loadAltcha();
  widget.reset();
  let result: { payload?: string } | null;
  try {
    result = await widget.verify();
  } catch {
    throw new ChallengeError("anti-spam check failed — please try again");
  }
  if (!result?.payload) {
    throw new ChallengeError("anti-spam check failed — please try again");
  }
  return result.payload;
}

export function findWidget(root: ParentNode, id: string): AltchaWidget | null {
  return root.querySelector<AltchaWidget>(`#${id}`);
}
