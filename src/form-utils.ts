import { showFlash } from "./layout/flash.js";

// Shared envelope for the auth/account form controllers. Every form's
// handler returns an outcome discriminated by `ok`; the success branch
// carries handler-specific payload (e.g. { session }, { profile }), the
// failure branch always has `error: string` (anything extra is fine).
export type FormResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string };

// Wires a form's submit listener: prevents default, toggles the submit
// button's disabled state, awaits the async handler, dispatches to
// onSuccess on `{ ok: true }`, and auto-flashes the error on `{ ok: false }`.
// The form/submit elements are looked up by id; if the form is missing the
// helper is a no-op (e.g. the page isn't the one being rendered).
export function wireFormSubmit<R extends FormResult>(opts: {
  formId: string;
  submitId: string;
  // Optional preflight; return false to skip this submit (e.g. some refs
  // missing). Mirrors the existing `if (!emailEl || !passwordEl) return`
  // guard so the helper never narrows a per-page invariant.
  guard?: () => boolean;
  handler: () => Promise<R>;
  onSuccess: (res: Extract<R, { ok: true }>) => void;
}): void {
  const form = document.getElementById(opts.formId);
  if (!(form instanceof HTMLFormElement)) return;
  const submit = document.getElementById(opts.submitId);
  const setBusy = (busy: boolean): void => {
    if (submit instanceof HTMLButtonElement) submit.disabled = busy;
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (opts.guard && !opts.guard()) return;
    setBusy(true);
    let res: R;
    try {
      res = await opts.handler();
    } finally {
      setBusy(false);
    }
    if (res.ok) {
      opts.onSuccess(res as Extract<R, { ok: true }>);
      return;
    }
    showFlash({ kind: "error", message: res.error });
  });
}
