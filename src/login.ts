import "./style.css";
import { login } from "./auth.js";
import { safeNext } from "./auth-redirect.js";

const form = document.getElementById("login-form") as HTMLFormElement | null;
const emailEl = document.getElementById("login-email") as HTMLInputElement | null;
const passwordEl = document.getElementById("login-password") as HTMLInputElement | null;
const errorEl = document.getElementById("login-error") as HTMLParagraphElement | null;
const submitEl = document.getElementById("login-submit") as HTMLButtonElement | null;

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!emailEl || !passwordEl) return;
  showError(null);
  setBusy(true);
  const res = await login(emailEl.value.trim(), passwordEl.value);
  setBusy(false);
  if (res.ok) {
    location.assign(safeNext());
    return;
  }
  showError(res.error);
});

function showError(msg: string | null): void {
  if (!errorEl) return;
  errorEl.hidden = msg === null;
  errorEl.textContent = msg ?? "";
}

function setBusy(busy: boolean): void {
  if (submitEl) submitEl.disabled = busy;
}
