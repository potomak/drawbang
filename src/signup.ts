import "./style.css";
import { register } from "./auth.js";
import { safeNext } from "./auth-redirect.js";
import { wireFormSubmit } from "./form-utils.js";
import { setPendingFlash } from "./layout/flash.js";

const emailEl = document.getElementById("signup-email") as HTMLInputElement | null;
const usernameEl = document.getElementById("signup-username") as HTMLInputElement | null;
const passwordEl = document.getElementById("signup-password") as HTMLInputElement | null;

wireFormSubmit({
  formId: "signup-form",
  submitId: "signup-submit",
  guard: () => !!(emailEl && usernameEl && passwordEl),
  handler: () =>
    register(
      emailEl!.value.trim(),
      usernameEl!.value.trim().toLowerCase(),
      passwordEl!.value,
    ),
  onSuccess: (res) => {
    setPendingFlash({
      kind: "info",
      message: `Welcome, ${res.session.username}! Your account is ready.`,
      autoDismissMs: 5500,
    });
    location.assign(safeNext());
  },
});
