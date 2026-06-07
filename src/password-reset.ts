import "./style.css";
import { resetPassword } from "./auth.js";
import { wireFormSubmit } from "./form-utils.js";
import { setPendingFlash } from "./layout/flash.js";

const token = new URLSearchParams(location.search).get("token");

if (!token) {
  // /password/reset is useless without a token — bounce to the request page.
  location.replace("/password/forgot");
} else {
  const passwordEl = document.getElementById("password-reset-new") as HTMLInputElement | null;

  wireFormSubmit({
    formId: "password-reset-form",
    submitId: "password-reset-submit",
    guard: () => !!passwordEl,
    handler: () => resetPassword(token, passwordEl!.value),
    onSuccess: () => {
      setPendingFlash({
        kind: "success",
        message: "Password updated. You're signed in.",
        autoDismissMs: 5500,
      });
      location.assign("/");
    },
  });
}
