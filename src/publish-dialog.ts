import type { AuthOutcome } from "./auth.js";
import { wireFormSubmit } from "./form-utils.js";

// Publish dialog for signed-out users. Publishing doesn't require an
// account (see "Anonymous publishing" in CLAUDE.md), but the choice is
// worth putting in front of people at the moment it's made rather than
// picking for them: a drawing published anonymously can never be
// reattributed afterwards, because drawing ids are content-addressed.
//
// Auth runs INLINE. register()/login() are plain fetches against
// /auth/*, so signing in from here never navigates away and the drawing
// on the canvas is never at risk. That's the whole reason this is a
// dialog instead of a redirect to /login?next=/draw — a redirect was the
// old behaviour, and losing work to it is the problem being fixed.

export type AuthMode = "login" | "signup";

// How the caller should proceed once the dialog closes. "authenticated"
// means a session is now in localStorage and the publish should carry it.
export type PublishDecision = "anonymous" | "authenticated" | "cancelled";

export interface AuthModeView {
  usernameRequired: boolean;
  passwordAutocomplete: "current-password" | "new-password";
  submitLabel: string;
}

// Everything that differs between the two modes, in one place so the
// username field's visibility can't drift from whether it's required —
// a hidden-but-required input blocks form submission with an error the
// user can never see.
export function authModeView(mode: AuthMode): AuthModeView {
  return mode === "signup"
    ? {
        usernameRequired: true,
        passwordAutocomplete: "new-password",
        submitLabel: "Sign up & publish",
      }
    : {
        usernameRequired: false,
        passwordAutocomplete: "current-password",
        submitLabel: "Log in & publish",
      };
}

export type AuthRequest =
  | { kind: "login"; email: string; password: string }
  | { kind: "signup"; email: string; username: string; password: string };

export interface RawAuthFields {
  email: string;
  username: string;
  password: string;
}

// Normalises the raw field values the same way the standalone /login and
// /signup pages do: emails and usernames are trimmed, usernames lowered
// (handles are lowercase per USERNAME_RE). Passwords are passed through
// untouched — trimming a password silently changes the user's secret.
export function buildAuthRequest(mode: AuthMode, raw: RawAuthFields): AuthRequest {
  const email = raw.email.trim();
  if (mode === "login") return { kind: "login", email, password: raw.password };
  return {
    kind: "signup",
    email,
    username: raw.username.trim().toLowerCase(),
    password: raw.password,
  };
}

export interface PublishDialogConfig {
  dialog: HTMLDialogElement;
  chooseStep: HTMLElement;
  authStep: HTMLElement;
  anonButton: HTMLButtonElement;
  toAuthButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  backButton: HTMLButtonElement;
  loginTab: HTMLButtonElement;
  signupTab: HTMLButtonElement;
  usernameField: HTMLElement;
  emailInput: HTMLInputElement;
  usernameInput: HTMLInputElement;
  passwordInput: HTMLInputElement;
  submitButton: HTMLButtonElement;
  statusEl: HTMLElement;
  formId: string;
  submitId: string;
  // Injected rather than imported: src/auth.ts reads import.meta.env at
  // module scope, so importing it here would make this module unloadable
  // outside Vite (node:test included).
  loginFn: (email: string, password: string) => Promise<AuthOutcome>;
  registerFn: (
    email: string,
    username: string,
    password: string,
  ) => Promise<AuthOutcome>;
}

export interface PublishDialogController {
  // Opens the dialog and resolves once the user has chosen. Never
  // rejects — a cancelled dialog is a normal outcome, not an error.
  decide(): Promise<PublishDecision>;
}

export function createPublishDialog(cfg: PublishDialogConfig): PublishDialogController {
  const { loginFn, registerFn } = cfg;

  let mode: AuthMode = "login";
  // Held between decide() and whichever control settles the dialog. Also
  // the "already settled" flag: the close event fires for our own
  // close() calls too, and must not overwrite a real decision with
  // "cancelled".
  let settle: ((d: PublishDecision) => void) | null = null;

  function finish(decision: PublishDecision): void {
    const resolve = settle;
    settle = null;
    if (cfg.dialog.open) cfg.dialog.close();
    resolve?.(decision);
  }

  function setStatus(message: string | null): void {
    cfg.statusEl.textContent = message ?? "";
    cfg.statusEl.hidden = message === null;
  }

  function setMode(next: AuthMode): void {
    mode = next;
    const view = authModeView(next);
    cfg.usernameField.hidden = !view.usernameRequired;
    cfg.usernameInput.required = view.usernameRequired;
    cfg.passwordInput.autocomplete = view.passwordAutocomplete;
    cfg.submitButton.textContent = view.submitLabel;
    cfg.loginTab.setAttribute("aria-selected", String(next === "login"));
    cfg.signupTab.setAttribute("aria-selected", String(next === "signup"));
    setStatus(null);
  }

  function showStep(step: "choose" | "auth"): void {
    cfg.chooseStep.hidden = step !== "choose";
    cfg.authStep.hidden = step !== "auth";
    if (step === "auth") cfg.emailInput.focus();
  }

  cfg.anonButton.addEventListener("click", () => finish("anonymous"));
  cfg.cancelButton.addEventListener("click", () => finish("cancelled"));
  cfg.toAuthButton.addEventListener("click", () => showStep("auth"));
  cfg.backButton.addEventListener("click", () => showStep("choose"));
  cfg.loginTab.addEventListener("click", () => setMode("login"));
  cfg.signupTab.addEventListener("click", () => setMode("signup"));
  // Esc (and any other native dismissal) counts as cancelling.
  cfg.dialog.addEventListener("close", () => finish("cancelled"));

  wireFormSubmit({
    formId: cfg.formId,
    submitId: cfg.submitId,
    handler: () => {
      setStatus(null);
      const req = buildAuthRequest(mode, {
        email: cfg.emailInput.value,
        username: cfg.usernameInput.value,
        password: cfg.passwordInput.value,
      });
      return req.kind === "login"
        ? loginFn(req.email, req.password)
        : registerFn(req.email, req.username, req.password);
    },
    // On success the session is already in localStorage, so the caller
    // just carries on and the publish picks it up via authHeader().
    onSuccess: () => finish("authenticated"),
    // In-dialog, not the global flash: the flash host renders beneath
    // the dialog's top layer and the user would never see it.
    onError: (message) => setStatus(message),
  });

  return {
    decide() {
      return new Promise<PublishDecision>((resolve) => {
        settle = resolve;
        cfg.passwordInput.value = "";
        setMode("login");
        showStep("choose");
        cfg.dialog.showModal();
      });
    },
  };
}
