import "./style.css";
import { login } from "./auth.js";
import { safeNext } from "./auth-redirect.js";
import { setPendingFlash, showFlash } from "./layout/flash.js";

const form = document.getElementById("login-form") as HTMLFormElement | null;
const emailEl = document.getElementById("login-email") as HTMLInputElement | null;
const passwordEl = document.getElementById("login-password") as HTMLInputElement | null;
const submitEl = document.getElementById("login-submit") as HTMLButtonElement | null;

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!emailEl || !passwordEl) return;
  setBusy(true);
  const res = await login(emailEl.value.trim(), passwordEl.value);
  setBusy(false);
  if (res.ok) {
    setPendingFlash({
      kind: "info",
      message: `Signed in as ${res.session.username}.`,
      autoDismissMs: 5500,
    });
    location.assign(safeNext());
    return;
  }
  showFlash({ kind: "error", message: res.error });
});

function setBusy(busy: boolean): void {
  if (submitEl) submitEl.disabled = busy;
}
