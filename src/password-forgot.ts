// TODO (#shared-form-utils): same boilerplate as login.ts / signup.ts /
// password-reset.ts / account.ts. Extract a shared createFormSubmitter()
// into src/form-utils.ts.

import "./style.css";
import { forgotPassword } from "./auth.js";
import { showFlash } from "./layout/flash.js";

const form = document.getElementById("password-forgot-form") as HTMLFormElement | null;
const emailEl = document.getElementById("password-forgot-email") as HTMLInputElement | null;
const submitEl = document.getElementById("password-forgot-submit") as HTMLButtonElement | null;

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!emailEl) return;
  if (submitEl) submitEl.disabled = true;
  const res = await forgotPassword(emailEl.value.trim());
  if (submitEl) submitEl.disabled = false;
  if (!res.ok) {
    showFlash({ kind: "error", message: res.error });
    return;
  }
  // Always the same message — we never reveal whether the email exists.
  if (form) form.hidden = true;
  showFlash({
    kind: "success",
    message: "If that email has an account, a reset link is on its way. Check your inbox.",
  });
});
