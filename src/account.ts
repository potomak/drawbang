import "./style.css";
import { deleteAccount, getProfile, getSession, logout, updateProfile } from "./auth.js";
import { wireFormSubmit } from "./form-utils.js";
import { setPendingFlash, showFlash } from "./layout/flash.js";

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
  const deletePasswordEl = document.getElementById("delete-password") as HTMLInputElement | null;
  const deleteConfirmEl = document.getElementById("delete-confirm") as HTMLInputElement | null;

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

  // Deleting is irreversible and takes the account's drawings with it, so
  // it asks for two independent things: the password (proves it's really
  // this person, not a borrowed session) and the username typed out
  // (proves they read what the button does). Both are checked here before
  // the request; the password is checked again server-side, which is the
  // one that counts.
  wireFormSubmit({
    formId: "delete-account-form",
    submitId: "delete-account-submit",
    guard: () => !!(deletePasswordEl && deleteConfirmEl),
    handler: async () => {
      if (deleteConfirmEl!.value.trim().toLowerCase() !== session!.username) {
        return {
          ok: false as const,
          status: 0,
          error: `Type "${session!.username}" to confirm.`,
        };
      }
      if (!window.confirm(
        `Permanently delete ${session!.username} and every drawing you've published? This cannot be undone.`,
      )) {
        return { ok: false as const, status: 0, error: "Deletion cancelled." };
      }
      return deleteAccount(deletePasswordEl!.value);
    },
    onSuccess: (res) => {
      // deleteAccount() already cleared the session.
      setPendingFlash({
        kind: "info",
        message:
          res.drawingsDeleted > 0
            ? `Account deleted, along with ${res.drawingsDeleted} drawing${res.drawingsDeleted === 1 ? "" : "s"}.`
            : "Account deleted.",
        autoDismissMs: 6000,
      });
      location.assign("/");
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
