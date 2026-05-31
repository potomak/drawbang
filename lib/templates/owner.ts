import { assetUrl } from "../../src/layout/asset-version.js";
import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";
import type { BadgeDef } from "../../config/badges.js";
import type { GalleryItem } from "./gallery.js";
import { esc } from "./_escape.js";

export interface OwnerStats {
  daily_total: number;
  daily_streak_current: number;
  daily_streak_longest: number;
  daily_badges: BadgeDef[];
}

export interface OwnerView {
  username: string;      // public handle, used in the URL
  user_id: string;       // 64-hex stable id
  // Newest-first.
  drawings: GalleryItem[];
  // Per-account stats (#115/#116). Optional: a brand-new owner with no
  // user_stats row yet renders as all-zeros from the handler. The
  // template renders nothing when omitted so dev/test paths stay
  // unaffected.
  stats?: OwnerStats;
  // drawing_id the user picked as their profile picture. Renders a small
  // inline gif next to the username when set.
  profile_picture_drawing_id?: string | null;
  // Follow counters (#202). SSR initial values; the Follow button's
  // filled state is hydrated client-side by /follow.js, and the
  // counters themselves are intentionally not re-fetched (a follower
  // sees their own change via the optimistic UI; everyone else picks
  // up the truth on the next edge-cache miss).
  follower_count?: number;
  following_count?: number;
  repo_url: string;
}

// Inline profile picture next to a username. Returns "" when drawing_id
// is missing or malformed so callers can splice it in unconditionally.
export function renderProfilePicture(
  drawing_id: string | null | undefined,
  username: string,
  size: number,
): string {
  if (!drawing_id || !/^[0-9a-f]{64}$/.test(drawing_id)) return "";
  const px = Math.max(8, Math.floor(size));
  return `<img class="profile-picture" src="/tiles/${esc(drawing_id)}.gif" alt="${esc(username)}" width="${px}" height="${px}" loading="lazy" />`;
}

// Follow button. Filled state + self-hiding are handled client-side by
// /follow.js. The data-follow-user-id attribute lets the hydration call
// skip the username→user_id lookup the handler would otherwise have to
// do.
export function renderFollowButton(args: {
  target_username: string;
  target_user_id: string;
}): string {
  return `<button class="follow-btn" type="button" data-follow-target="${esc(args.target_username)}" data-follow-user-id="${esc(args.target_user_id)}" aria-pressed="false" hidden>
        <span class="follow-label">Follow</span>
      </button>`;
}

export default function renderOwner(v: OwnerView): string {
  const items = v.drawings
    .map(
      (d) => `          <li>
            <a href="${esc(d.href ?? `/d/${d.id}`)}" aria-label="${esc(d.id_short)}">
              <img src="${esc(d.thumb ?? `/tiles/${d.id}.gif`)}" alt="" width="128" height="128" loading="lazy" />
            </a>
          </li>`,
    )
    .join("\n");
  const count = v.drawings.length;
  const countLabel = `${count} ${count === 1 ? "drawing" : "drawings"}`;
  const body = count
    ? `      <p class="page-sub">${esc(countLabel)}</p>
      <ul class="img-grid">
${items}
      </ul>`
    : `      <p class="muted">No drawings published by this account yet.</p>`;
  const stats = v.stats ? renderStats(v.stats) : "";
  const social = renderSocialBlock(v);
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(v.username)}</title>
    <link rel="stylesheet" href="${assetUrl("/gallery-v2.css")}" />
  </head>
  <body>
    ${renderHeader({ active: "identity" })}
    <main>
      <h1 class="page-title">${renderProfilePicture(v.profile_picture_drawing_id, v.username, 32)}Drawings by ${esc(v.username)}</h1>
${social}${stats}${body}
    </main>
    ${renderFooter({ active: "identity", repoUrl: v.repo_url })}
    <script src="${assetUrl("/follow.js")}"></script>
  </body>
</html>
`;
}

function renderSocialBlock(v: OwnerView): string {
  // The "anonymous" sentinel bucket holds legacy migrated drawings and
  // can't be followed — there's no real account behind it. Skip the
  // social row entirely there.
  if (v.username === "anonymous") return "";
  const followers = v.follower_count ?? 0;
  const following = v.following_count ?? 0;
  return `      <div class="ow-social">
        ${renderFollowButton({ target_username: v.username, target_user_id: v.user_id })}
        <a class="ow-count" href="/u/${esc(v.username)}/followers">
          <strong data-follower-count>${esc(followers)}</strong>
          <span>${followers === 1 ? "follower" : "followers"}</span>
        </a>
        <a class="ow-count" href="/u/${esc(v.username)}/following">
          <strong data-following-count>${esc(following)}</strong>
          <span>following</span>
        </a>
      </div>
`;
}

function renderStats(s: OwnerStats): string {
  const dailyLine = formatDailyLine(s);
  const badges = s.daily_badges;
  const badgesHidden = badges.length === 0 ? " hidden" : "";
  return `      <dl class="ow-stats">
      <dt>Daily drawings</dt>
      <dd data-stats-daily>${dailyLine}</dd>
      <dt data-stats-badges-dt${badgesHidden}>Badges</dt>
      <dd data-stats-badges-dd${badgesHidden}><ul class="ow-badges" data-stats-badges>${badges
        .map((b) => `<li data-badge-id="${esc(b.id)}">${esc(b.label)}</li>`)
        .join("")}</ul></dd>
      </dl>
`;
}

function formatDailyLine(s: OwnerStats): string {
  if (s.daily_total === 0) return "No drawings yet";
  return `${esc(s.daily_streak_current)}-day streak · best ${esc(s.daily_streak_longest)} · ${esc(s.daily_total)} drawing${s.daily_total === 1 ? "" : "s"} total`;
}
