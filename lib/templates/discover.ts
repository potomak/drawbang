import type {
  DiscoverArtist,
  DiscoverData,
  DiscoverDrawing,
} from "../../ingest/discover-handler.js";
import { esc } from "./_escape.js";

// SSR markup for the feed's right "discover" rail. Two stacked modules
// (Most Liked · 30D, Trending Artists). The page that consumes this
// (lib/templates/home.ts) passes the output as `rightRailContent` to
// the chrome's renderFooter, which slots it into the .rail-right
// <aside> the shell already provides.
//
// No interactive elements — the rail is a static snapshot. The feed
// page lives behind a 5-minute edge cache, so the rail freshens at
// the same cadence as the cards below it. If we ever need
// independent refresh, expose a JSON endpoint and stamp via a small
// client script.

export function renderDiscover(data: DiscoverData): string {
  if (!data.most_liked_30d.length && !data.trending_artists.length) {
    return "";
  }
  return `${data.most_liked_30d.length ? renderMostLiked(data.most_liked_30d) : ""}
${data.trending_artists.length ? renderTrendingArtists(data.trending_artists) : ""}`;
}

function renderMostLiked(items: DiscoverDrawing[]): string {
  const rows = items
    .map(
      (d, i) => `        <li>
          <a class="rr-row" href="${esc(d.drawing_url)}">
            <span class="rr-rank">${i + 1}</span>
            <img class="rr-thumb" src="${esc(d.thumb_url)}" alt="" width="32" height="32" loading="lazy">
            <span class="rr-author">${d.author_username ? esc(d.author_username) : "anonymous"}</span>
            <span class="rr-like-count">♥ ${esc(d.like_count)}</span>
          </a>
        </li>`,
    )
    .join("\n");
  return `<section class="rr-module">
      <h2 class="rr-h">Most Liked · 30D</h2>
      <ol class="rr-list">
${rows}
      </ol>
    </section>`;
}

function renderTrendingArtists(items: DiscoverArtist[]): string {
  const rows = items
    .map(
      (a, i) => `        <li>
          <a class="rr-row" href="/u/${esc(a.username)}">
            <span class="rr-rank">${i + 1}</span>
            ${renderArtistAvatar(a)}
            <span class="rr-author">${esc(a.username)}</span>
            <span class="rr-meta">${esc(a.drawing_count_30d)} ${a.drawing_count_30d === 1 ? "drawing" : "drawings"}</span>
          </a>
        </li>`,
    )
    .join("\n");
  return `<section class="rr-module">
      <h2 class="rr-h">Trending Artists</h2>
      <ol class="rr-list">
${rows}
      </ol>
    </section>`;
}

function renderArtistAvatar(a: DiscoverArtist): string {
  if (!a.profile_picture_drawing_id) {
    return `<span class="rr-thumb rr-thumb--placeholder" data-profile-picture-username="${esc(a.username)}" data-profile-picture-size="32"></span>`;
  }
  return `<img class="rr-thumb" src="/tiles/${esc(a.profile_picture_drawing_id)}.gif" alt="" width="32" height="32" loading="lazy" data-profile-picture-username="${esc(a.username)}" data-profile-picture-size="32">`;
}
