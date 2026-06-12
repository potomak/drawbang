import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import renderHome, {
  renderFeedCard,
  renderFeedFragment,
  type FeedItem,
} from "../lib/templates/home.js";

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  const id = overrides.id ?? "a".repeat(64);
  // `?? defaultAuthor` would collapse an intentional `null` (anonymous),
  // since `??` also short-circuits on null. Use an explicit presence
  // check so the caller can opt out.
  const defaultAuthor = { username: "alice", profile_picture_drawing_id: null };
  const author = "author" in overrides
    ? (overrides.author ?? null)
    : defaultAuthor;
  return {
    id,
    id_short: overrides.id_short ?? id.slice(0, 8),
    href: overrides.href ?? `/d/${id}`,
    thumb: overrides.thumb ?? `/tiles/${id}.gif`,
    created_at: overrides.created_at ?? "2026-05-01T12:00:00.000Z",
    like_count: overrides.like_count ?? 0,
    author,
  };
}

describe("renderHome", () => {
  test("renders a card per item with a /u/<username> author link", () => {
    const html = renderHome({
      items: [item({ author: { username: "alice", profile_picture_drawing_id: null } })],
      repo_url: "https://github.com/test/test",
    });
    assert.match(html, /<main>/);
    assert.match(html, /<ul class="feed-list" data-infinite-list>/);
    assert.match(html, /<article class="feed-card">/);
    assert.match(html, /<a class="feed-card-author-link" href="\/u\/alice">alice<\/a>/);
    assert.doesNotMatch(html, /@alice/);
    assert.match(html, new RegExp(`<a class="feed-card-art" href="/d/${"a".repeat(64)}"`));
  });

  test("anonymous items render without a profile link", () => {
    const html = renderHome({
      items: [item({ author: null })],
      repo_url: "https://github.com/test/test",
    });
    assert.match(html, /<span class="feed-card-author-link feed-card-author-anon">anonymous<\/span>/);
    assert.doesNotMatch(html, /<a class="feed-card-author-link"/);
  });

  test("renders the profile picture in the left rail when set", () => {
    const pictureId = "b".repeat(64);
    const html = renderHome({
      items: [
        item({ author: { username: "alice", profile_picture_drawing_id: pictureId } }),
      ],
      repo_url: "https://github.com/test/test",
    });
    // The pp link wraps the img and sits in the left rail (.feed-card-pp).
    assert.match(html, /<a class="feed-card-pp" href="\/u\/alice"/);
    assert.match(
      html,
      new RegExp(`<img class="profile-picture" src="/tiles/${pictureId}\\.gif"`),
    );
    // /hydrate.js reads these to swap the image in/out without a page reload.
    assert.match(html, /data-profile-picture-username="alice"/);
    assert.match(html, /data-profile-picture-size="48"/);
  });

  test("renders a monogram placeholder in the left rail when no picture is set", () => {
    const html = renderHome({
      items: [
        item({ author: { username: "alice", profile_picture_drawing_id: null } }),
      ],
      repo_url: "https://github.com/test/test",
    });
    assert.match(html, /<a class="feed-card-pp" href="\/u\/alice"/);
    assert.match(html, /class="profile-picture profile-picture-placeholder"[^>]*>A</);
    // Placeholder still carries the hydration attrs so /hydrate.js can
    // upgrade it to an <img> when alice sets a picture later.
    assert.match(html, /class="profile-picture profile-picture-placeholder"[^>]*data-profile-picture-username="alice"/);
  });

  test("emits an infinite-scroll sentinel + loads the shared observer script when paginated", () => {
    const html = renderHome({
      items: [item()],
      next_fragment_url: "/feed/items?cursor=foo",
      repo_url: "https://github.com/test/test",
    });
    assert.match(html, /data-infinite-sentinel/);
    assert.match(html, /data-infinite-target="\[data-infinite-list\]"/);
    assert.match(html, /data-next="\/feed\/items\?cursor=foo"/);
    assert.match(html, /<script src="\/infinite-scroll\.js"/);
  });

  test("empty-state renders the editor link instead of the list", () => {
    const html = renderHome({
      items: [],
      repo_url: "https://github.com/test/test",
    });
    assert.doesNotMatch(html, /<ul class="feed-list"/);
    assert.match(html, /<p class="feed-empty">No drawings yet/);
    assert.match(html, /<a href="\/draw">open the editor<\/a>/);
  });

  test("the Home nav link is gone — the logo is the home link", () => {
    const html = renderHome({
      items: [item()],
      repo_url: "https://github.com/test/test",
    });
    assert.doesNotMatch(html, /data-nav="home"/);
    assert.match(html, /<a class="hdr-logo" href="\/"/);
  });
});

describe("renderFeedCard", () => {
  test("wraps in <li><article class=\"feed-card\">", () => {
    const html = renderFeedCard(item());
    assert.match(html, /^<li><article class="feed-card">/);
    assert.match(html, /<\/article><\/li>$/);
  });

  test("links the art to /d/<id>", () => {
    const id = "f".repeat(64);
    const html = renderFeedCard(item({ id }));
    assert.match(html, new RegExp(`<a class="feed-card-art" href="/d/${id}"`));
  });

  test("renders a like button with the SSR count + data-like-target", () => {
    const id = "c".repeat(64);
    const html = renderFeedCard(item({ id, like_count: 7 }));
    assert.match(html, new RegExp(`data-like-target="${id}"`));
    assert.match(html, /aria-pressed="false"/);
    assert.match(html, /<span class="like-count" data-like-count>7<\/span>/);
  });

  test("renders a Remix action linking to /draw?fork=<id>", () => {
    const id = "c".repeat(64);
    const html = renderFeedCard(item({ id }));
    assert.match(html, new RegExp(`<a class="feed-action" href="/draw\\?fork=${id}"`));
    assert.match(html, />Remix<\/span>/);
    assert.doesNotMatch(html, />Fork<\/span>/);
  });

  test("renders a Share button with data-share-button + path target", () => {
    const id = "c".repeat(64);
    const html = renderFeedCard(item({ id, id_short: id.slice(0, 8) }));
    assert.match(html, /data-share-button/);
    assert.match(html, new RegExp(`data-share-target="/d/${id}"`));
    assert.match(html, />Share<\/span>/);
  });

  test("View permalink is gone (the image is the click target now)", () => {
    const html = renderFeedCard(item());
    assert.doesNotMatch(html, /feed-card-permalink/);
    assert.doesNotMatch(html, />View<\/a>/);
  });

  test("layout is horizontal: profile column + main column siblings", () => {
    const html = renderFeedCard(item());
    // shipordie.club layout: pp left rail + main column on right; author
    // moved out of its own left column and into the main column's header.
    assert.match(html, /<a class="feed-card-pp"/);
    assert.match(html, /<div class="feed-card-main">/);
    assert.match(html, /<header class="feed-card-author">/);
  });

  test("drawing has no rectangle around it (no border-ish wrapper class kept)", () => {
    const html = renderFeedCard(item());
    // The container exists for the link semantics but the old border-only
    // .feed-card-meta wrapper is gone — actions live in feed-card-actions.
    assert.doesNotMatch(html, /class="feed-card-meta"/);
    assert.match(html, /<div class="feed-card-actions">/);
  });

  test("renderHome loads /like.js and /share.js so the buttons get wired", () => {
    const html = renderHome({
      items: [item()],
      repo_url: "https://github.com/test/test",
    });
    assert.match(html, /<script src="\/like\.js"><\/script>/);
    assert.match(html, /<script src="\/share\.js"><\/script>/);
  });

  test("renders a bookmark button with data-bookmark-target", () => {
    const id = "d".repeat(64);
    const html = renderFeedCard(item({ id }));
    assert.match(html, new RegExp(`data-bookmark-target="${id}"`));
    assert.match(html, /class="bookmark-btn feed-action"/);
  });

  test("renderHome loads /bookmark.js so the bookmark button gets wired", () => {
    const html = renderHome({
      items: [item()],
      repo_url: "https://github.com/test/test",
    });
    assert.match(html, /<script src="\/bookmark\.js"><\/script>/);
  });
});

describe("prompt banner", () => {
  const prompt = {
    slug: "tiny-ghost",
    title: "Tiny ghost",
    blurb: "Boo, but make it adorable.",
  };

  test("renders title, blurb, and the Draw-this CTA above the feed", () => {
    const html = renderHome({
      items: [item()],
      prompt,
      repo_url: "https://github.com/test/test",
    });
    assert.match(html, /<section class="prompt-banner" aria-label="Today's prompt">/);
    assert.match(html, /<h2 class="prompt-banner-title">Tiny ghost<\/h2>/);
    assert.match(html, /<p class="prompt-banner-blurb">Boo, but make it adorable\.<\/p>/);
    assert.match(html, /<a class="btn primary prompt-banner-cta" href="\/draw\?prompt=tiny-ghost">Draw this<\/a>/);
    // Banner sits above the cards.
    const bannerIdx = html.indexOf("prompt-banner");
    const listIdx = html.indexOf('<ul class="feed-list"');
    assert.ok(bannerIdx > -1 && listIdx > -1 && bannerIdx < listIdx);
  });

  test("fires a guarded prompt_banner_view gtag event carrying the slug", () => {
    const html = renderHome({
      items: [item()],
      prompt,
      repo_url: "https://github.com/test/test",
    });
    assert.match(
      html,
      /<script>typeof gtag==="function"&&gtag\("event","prompt_banner_view",\{slug:"tiny-ghost"\}\);<\/script>/,
    );
  });

  test("omitted entirely when the view has no prompt", () => {
    const html = renderHome({
      items: [item()],
      repo_url: "https://github.com/test/test",
    });
    assert.doesNotMatch(html, /prompt-banner/);
    assert.doesNotMatch(html, /prompt_banner_view/);
  });

  test("still renders on the empty feed state", () => {
    const html = renderHome({
      items: [],
      prompt,
      repo_url: "https://github.com/test/test",
    });
    assert.match(html, /class="prompt-banner"/);
    assert.match(html, /<p class="feed-empty">No drawings yet/);
  });

  test("renderFeedFragment never includes the banner", () => {
    const html = renderFeedFragment([item()], "/feed/items?cursor=x");
    assert.doesNotMatch(html, /prompt-banner/);
    assert.doesNotMatch(html, /prompt_banner_view/);
  });
});

describe("renderFeedFragment", () => {
  test("returns just the cards (no <html>) and appends a sentinel when paginated", () => {
    const html = renderFeedFragment([item()], "/feed/items?cursor=x");
    assert.doesNotMatch(html, /<html/);
    assert.match(html, /<article class="feed-card">/);
    assert.match(html, /<li class="feed-sentinel" data-infinite-sentinel data-infinite-target="\[data-infinite-list\]" data-next="\/feed\/items\?cursor=x">/);
  });

  test("omits the sentinel on the last page (next=null)", () => {
    const html = renderFeedFragment([item()], null);
    assert.doesNotMatch(html, /data-infinite-sentinel/);
  });
});
