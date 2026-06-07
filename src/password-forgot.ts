import "./style.css";
import { forgotPassword } from "./auth.js";
import { wireFormSubmit } from "./form-utils.js";
import { showFlash } from "./layout/flash.js";

const form = document.getElementById("password-forgot-form") as HTMLFormElement | null;
const emailEl = document.getElementById("password-forgot-email") as HTMLInputElement | null;

wireFormSubmit({
  formId: "password-forgot-form",
  submitId: "password-forgot-submit",
  guard: () => !!emailEl,
  handler: () => forgotPassword(emailEl!.value.trim()),
  onSuccess: () => {
    // Same message either way — we never reveal whether the email exists.
    if (form) form.hidden = true;
    showFlash({
      kind: "success",
      message: "If that email has an account, a reset link is on its way. Check your inbox.",
    });
  },
});
