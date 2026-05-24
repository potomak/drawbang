import "./style.css";
import { confirmReset, requestReset } from "./auth.js";

const token = new URLSearchParams(location.search).get("token");

const requestForm = document.getElementById("reset-request-form") as HTMLFormElement | null;
const confirmForm = document.getElementById("reset-confirm-form") as HTMLFormElement | null;
const note = document.getElementById("reset-note") as HTMLParagraphElement | null;

if (token) {
  setupConfirm(token);
} else {
  setupRequest();
}

function setupRequest(): void {
  if (!requestForm) return;
  requestForm.hidden = false;
  const emailEl = document.getElementById("reset-email") as HTMLInputElement | null;
  const errorEl = document.getElementById("reset-request-error") as HTMLParagraphElement | null;
  const submitEl = document.getElementById("reset-request-submit") as HTMLButtonElement | null;

  requestForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!emailEl) return;
    setError(errorEl, null);
    if (submitEl) submitEl.disabled = true;
    const res = await requestReset(emailEl.value.trim());
    if (submitEl) submitEl.disabled = false;
    if (!res.ok) {
      setError(errorEl, res.error);
      return;
    }
    // Always the same message — we never reveal whether the email exists.
    requestForm.hidden = true;
    showNote("If that email has an account, a reset link is on its way. Check your inbox.");
  });
}

function setupConfirm(resetToken: string): void {
  if (!confirmForm) return;
  confirmForm.hidden = false;
  const passwordEl = document.getElementById("reset-password") as HTMLInputElement | null;
  const errorEl = document.getElementById("reset-confirm-error") as HTMLParagraphElement | null;
  const submitEl = document.getElementById("reset-confirm-submit") as HTMLButtonElement | null;

  confirmForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!passwordEl) return;
    setError(errorEl, null);
    if (submitEl) submitEl.disabled = true;
    const res = await confirmReset(resetToken, passwordEl.value);
    if (submitEl) submitEl.disabled = false;
    if (res.ok) {
      location.assign("/");
      return;
    }
    setError(errorEl, res.error);
  });
}

function setError(el: HTMLParagraphElement | null, msg: string | null): void {
  if (!el) return;
  el.hidden = msg === null;
  el.textContent = msg ?? "";
}

function showNote(msg: string): void {
  if (!note) return;
  note.hidden = false;
  note.textContent = msg;
}
