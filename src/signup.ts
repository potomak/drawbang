import "./style.css";
import { register } from "./auth.js";
import { safeNext } from "./auth-redirect.js";

const form = document.getElementById("signup-form") as HTMLFormElement | null;
const emailEl = document.getElementById("signup-email") as HTMLInputElement | null;
const usernameEl = document.getElementById("signup-username") as HTMLInputElement | null;
const passwordEl = document.getElementById("signup-password") as HTMLInputElement | null;
const errorEl = document.getElementById("signup-error") as HTMLParagraphElement | null;
const submitEl = document.getElementById("signup-submit") as HTMLButtonElement | null;

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!emailEl || !usernameEl || !passwordEl) return;
  showError(null);
  setBusy(true);
  const res = await register(
    emailEl.value.trim(),
    usernameEl.value.trim().toLowerCase(),
    passwordEl.value,
  );
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
