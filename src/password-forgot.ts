import "./style.css";
import { forgotPassword } from "./auth.js";
import { findWidget, loadAltcha, solveChallenge } from "./altcha.js";
import { wireFormSubmit } from "./form-utils.js";
import { showFlash } from "./layout/flash.js";

const form = document.getElementById("password-forgot-form") as HTMLFormElement | null;
const emailEl = document.getElementById("password-forgot-email") as HTMLInputElement | null;

// This route makes SES send mail to whatever address is submitted, which
// is the abuse worth paying for — so it's behind the same proof-of-work
// gate as signup. Warm the widget on load so the solve is underway before
// the user finishes typing.
void loadAltcha();

wireFormSubmit({
  formId: "password-forgot-form",
  submitId: "password-forgot-submit",
  guard: () => !!emailEl,
  handler: async () =>
    forgotPassword(
      emailEl!.value.trim(),
      await solveChallenge(findWidget(document, "password-forgot-altcha"))
    ),
  onSuccess: () => {
    // Same message either way — we never reveal whether the email exists.
    if (form) form.hidden = true;
    showFlash({
      kind: "success",
      message: "If that email has an account, a reset link is on its way. Check your inbox.",
    });
  },
});
