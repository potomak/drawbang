import "./style.css";
import { getSession, logout } from "./auth.js";

const session = getSession();
if (!session) {
  location.assign("/login?next=/account");
} else {
  const body = document.getElementById("account-body");
  const usernameEl = document.getElementById("account-username");
  const profileEl = document.getElementById("account-profile") as HTMLAnchorElement | null;
  const logoutEl = document.getElementById("account-logout") as HTMLButtonElement | null;

  if (usernameEl) usernameEl.textContent = session.username;
  if (profileEl) profileEl.href = `/u/${session.username}`;
  if (body) body.hidden = false;

  logoutEl?.addEventListener("click", () => {
    logout();
    location.assign("/login");
  });
}
