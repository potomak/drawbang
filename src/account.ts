import "./style.css";
import { getProfile, getSession, logout, updateProfile } from "./auth.js";
import { wireFormSubmit } from "./form-utils.js";
import { showFlash } from "./layout/flash.js";

const session = getSession();
if (!session) {
  location.assign("/login?next=/account");
} else {
  const body = document.getElementById("account-body");
  const usernameEl = document.getElementById("account-username");
  const profileEl = document.getElementById("account-profile") as HTMLAnchorElement | null;
  const logoutEl = document.getElementById("account-logout") as HTMLButtonElement | null;
  const bioEl = document.getElementById("edit-bio") as HTMLTextAreaElement | null;
  const linkEl = document.getElementById("edit-link") as HTMLInputElement | null;

  if (usernameEl) usernameEl.textContent = session.username;
  if (profileEl) profileEl.href = `/u/${session.username}`;
  if (body) body.hidden = false;

  logoutEl?.addEventListener("click", () => {
    logout();
    location.assign("/login");
  });

  void prefillProfile();

  wireFormSubmit({
    formId: "edit-profile-form",
    submitId: "edit-profile-submit",
    guard: () => !!(bioEl && linkEl),
    handler: () => {
      const bio = bioEl!.value.length === 0 ? null : bioEl!.value;
      const link = linkEl!.value.trim().length === 0 ? null : linkEl!.value.trim();
      return updateProfile({ bio, link });
    },
    onSuccess: (res) => {
      bioEl!.value = res.profile.bio ?? "";
      linkEl!.value = res.profile.link ?? "";
      showFlash({ kind: "info", message: "Profile saved.", autoDismissMs: 3000 });
    },
  });

  async function prefillProfile(): Promise<void> {
    if (!bioEl || !linkEl) return;
    const res = await getProfile();
    if (!res.ok) return;
    bioEl.value = res.profile.bio ?? "";
    linkEl.value = res.profile.link ?? "";
  }
}
