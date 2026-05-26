import "./style.css";
import { resetPassword } from "./auth.js";
import { setPendingFlash, showFlash } from "./layout/flash.js";

const token = new URLSearchParams(location.search).get("token");

if (!token) {
  // /password/reset is useless without a token — bounce to the request page.
  location.replace("/password/forgot");
} else {
  const form = document.getElementById("password-reset-form") as HTMLFormElement | null;
  const passwordEl = document.getElementById("password-reset-new") as HTMLInputElement | null;
  const submitEl = document.getElementById("password-reset-submit") as HTMLButtonElement | null;

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!passwordEl) return;
    if (submitEl) submitEl.disabled = true;
    const res = await resetPassword(token, passwordEl.value);
    if (submitEl) submitEl.disabled = false;
    if (res.ok) {
      setPendingFlash({
        kind: "success",
        message: "Password updated. You're signed in.",
        autoDismissMs: 5500,
      });
      location.assign("/");
      return;
    }
    showFlash({ kind: "error", message: res.error });
  });
}
