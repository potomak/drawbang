// TODO (#shared-template-utils): HTML head/shell duplication + inline
// infinite-scroll observer — see home.ts for the lift plan.

import { assetUrl } from "../../src/layout/asset-version.js";
import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderAnalytics, renderMetaPixel } from "../../src/layout/tracking.js";
import { esc } from "./_escape.js";
import { renderFollowButton } from "./owner.js";

// /u/<username>/followers and /u/<username>/following — paginated lists
// of accounts. Each card carries the target's username, profile picture,
// and a Follow button (so the viewer can follow/unfollow without
// navigating away). Profile pictures are batched by the handler via
// userStore.getByUsername; accounts without one fall back to a
// single-letter placeholder.
//
// Cards are server-rendered with the SSR'd outline state; `/follow.js`
// hydrates the filled state for the signed-in viewer.

export interface FollowListItem {
  username: string;
  user_id: string;
  profile_picture_drawing_id?: string | null;
}

export type FollowListKind = "followers" | "following";

export interface FollowListView {
  // The profile the page is *about*.
  owner_username: string;
  kind: FollowListKind;
  items: FollowListItem[];
  // When present, the page renders an infinite-scroll sentinel pointing
  // at this URL. Same pattern as the gallery/feed.
  next_fragment_url?: string;
  repo_url: string;
}

export function renderFollowCard(item: FollowListItem): string {
  const pp = renderFollowCardPicture(item);
  return `<li><article class="follow-card">
  <a class="follow-card-pp" href="/u/${esc(item.username)}" aria-label="${esc(item.username)}'s profile">${pp}</a>
  <a class="follow-card-name" href="/u/${esc(item.username)}">${esc(item.username)}</a>
  ${renderFollowButton({ target_username: item.username, target_user_id: item.user_id })}
</article></li>`;
}

function renderFollowCardPicture(item: FollowListItem): string {
  const id = item.profile_picture_drawing_id;
  const size = 44;
  const dataAttrs = `data-profile-picture-username="${esc(item.username)}" data-profile-picture-size="${size}"`;
  if (id && /^[0-9a-f]{64}$/.test(id)) {
    return `<img class="profile-picture" src="/tiles/${esc(id)}.gif" alt="${esc(item.username)}" width="${size}" height="${size}" loading="lazy" ${dataAttrs} />`;
  }
  const initial = esc(item.username.charAt(0).toUpperCase());
  return `<span class="profile-picture profile-picture-placeholder" aria-hidden="true" ${dataAttrs}>${initial}</span>`;
}

export function renderFollowListFragment(
  items: FollowListItem[],
  next_fragment_url: string | null,
): string {
  const cards = items.map(renderFollowCard).join("\n");
  if (!next_fragment_url) return cards;
  return `${cards}
<li class="follow-sentinel" data-follow-sentinel data-next="${esc(next_fragment_url)}"></li>`;
}

export default function renderFollowList(v: FollowListView): string {
  const cards = v.items.map(renderFollowCard).join("\n");
  const empty = v.items.length === 0;
  const heading =
    v.kind === "followers"
      ? `${v.owner_username} · Followers`
      : `${v.owner_username} · Following`;
  const emptyMsg =
    v.kind === "followers" ? "No followers yet." : "Not following anyone yet.";
  const body = empty
    ? `      <p class="muted">${esc(emptyMsg)}</p>`
    : `      <ul class="follow-list" data-follow-list>
${cards}${v.next_fragment_url ? `
        <li class="follow-sentinel" data-follow-sentinel data-next="${esc(v.next_fragment_url)}"></li>` : ""}
      </ul>`;
  const observer = v.next_fragment_url ? renderObserverScript() : "";
  return `<!doctype html>
<html lang="en">
  <head>
    ${renderAnalytics()}
    ${renderMetaPixel()}
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Draw! · ${esc(heading)}</title>
    <link rel="stylesheet" href="${assetUrl("/gallery-v2.css")}" />
  </head>
  <body>
    ${renderHeader({ active: "identity" })}
    <main>
      <h1 class="page-title">${esc(heading)}</h1>
      <p class="page-sub"><a href="/u/${esc(v.owner_username)}">← back to profile</a></p>
${body}
    </main>
    ${renderFooter({ active: "identity", repoUrl: v.repo_url })}
${observer}    <script src="${assetUrl("/follow.js")}"></script>
  </body>
</html>
`;
}

function renderObserverScript(): string {
  return `    <script>
(function () {
  function wire(sentinel) {
    if (!sentinel || sentinel.dataset.wired) return;
    sentinel.dataset.wired = "1";
    var next = sentinel.dataset.next;
    if (!next) return;
    var io = new IntersectionObserver(async function (entries) {
      if (!entries.some(function (e) { return e.isIntersecting; })) return;
      io.disconnect();
      try {
        var res = await fetch(next);
        if (!res.ok) return;
        var html = await res.text();
        var list = document.querySelector("[data-follow-list]");
        if (list) {
          sentinel.remove();
          list.insertAdjacentHTML("beforeend", html);
        }
        var nextSentinel = document.querySelector("[data-follow-sentinel]:not([data-wired])");
        if (nextSentinel) wire(nextSentinel);
      } catch (e) {}
    }, { rootMargin: "200px" });
    io.observe(sentinel);
  }
  document.querySelectorAll("[data-follow-sentinel]").forEach(wire);
})();
    </script>
`;
}
