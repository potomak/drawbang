import "./style.css";
import { login } from "./auth.js";
import { safeNext } from "./auth-redirect.js";
import { wireFormSubmit } from "./form-utils.js";
import { setPendingFlash } from "./layout/flash.js";

const emailEl = document.getElementById("login-email") as HTMLInputElement | null;
const passwordEl = document.getElementById("login-password") as HTMLInputElement | null;

wireFormSubmit({
  formId: "login-form",
  submitId: "login-submit",
  guard: () => !!(emailEl && passwordEl),
  handler: () => login(emailEl!.value.trim(), passwordEl!.value),
  onSuccess: (res) => {
    setPendingFlash({
      kind: "info",
      message: `Signed in as ${res.session.username}.`,
      autoDismissMs: 5500,
    });
    location.assign(safeNext());
  },
});
