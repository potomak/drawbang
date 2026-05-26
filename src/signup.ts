import "./style.css";
import { register } from "./auth.js";
import { safeNext } from "./auth-redirect.js";
import { setPendingFlash, showFlash } from "./layout/flash.js";

const form = document.getElementById("signup-form") as HTMLFormElement | null;
const emailEl = document.getElementById("signup-email") as HTMLInputElement | null;
const usernameEl = document.getElementById("signup-username") as HTMLInputElement | null;
const passwordEl = document.getElementById("signup-password") as HTMLInputElement | null;
const submitEl = document.getElementById("signup-submit") as HTMLButtonElement | null;

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!emailEl || !usernameEl || !passwordEl) return;
  setBusy(true);
  const res = await register(
    emailEl.value.trim(),
    usernameEl.value.trim().toLowerCase(),
    passwordEl.value,
  );
  setBusy(false);
  if (res.ok) {
    setPendingFlash({
      kind: "info",
      message: `Welcome, ${res.session.username}! Your account is ready.`,
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
