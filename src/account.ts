// TODO (#shared-form-utils): the edit-profile form here repeats the same
// pattern as login.ts / signup.ts / password-forgot.ts / password-reset.ts.
// Extract a shared createFormSubmitter() into src/form-utils.ts.

import "./style.css";
import { getProfile, getSession, logout, updateProfile } from "./auth.js";
import { showFlash } from "./layout/flash.js";

const session = getSession();
if (!session) {
  location.assign("/login?next=/account");
} else {
  const body = document.getElementById("account-body");
  const usernameEl = document.getElementById("account-username");
  const profileEl = document.getElementById("account-profile") as HTMLAnchorElement | null;
  const logoutEl = document.getElementById("account-logout") as HTMLButtonElement | null;
  const form = document.getElementById("edit-profile-form") as HTMLFormElement | null;
  const bioEl = document.getElementById("edit-bio") as HTMLTextAreaElement | null;
  const linkEl = document.getElementById("edit-link") as HTMLInputElement | null;
  const submitEl = document.getElementById("edit-profile-submit") as HTMLButtonElement | null;

  if (usernameEl) usernameEl.textContent = session.username;
  if (profileEl) profileEl.href = `/u/${session.username}`;
  if (body) body.hidden = false;

  logoutEl?.addEventListener("click", () => {
    logout();
    location.assign("/login");
  });

  void prefillProfile();

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!bioEl || !linkEl) return;
    const bio = bioEl.value.length === 0 ? null : bioEl.value;
    const link = linkEl.value.trim().length === 0 ? null : linkEl.value.trim();
    setBusy(true);
    const res = await updateProfile({ bio, link });
    setBusy(false);
    if (res.ok) {
      bioEl.value = res.profile.bio ?? "";
      linkEl.value = res.profile.link ?? "";
      showFlash({ kind: "info", message: "Profile saved.", autoDismissMs: 3000 });
    } else {
      showFlash({ kind: "error", message: res.error });
    }
  });

  async function prefillProfile(): Promise<void> {
    if (!bioEl || !linkEl) return;
    const res = await getProfile();
    if (!res.ok) return;
    bioEl.value = res.profile.bio ?? "";
    linkEl.value = res.profile.link ?? "";
  }

  function setBusy(busy: boolean): void {
    if (submitEl) submitEl.disabled = busy;
  }
}
