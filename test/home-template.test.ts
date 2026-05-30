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
  const defaultAuthor = { username: "alice", avatar_drawing_id: null };
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
      items: [item({ author: { username: "alice", avatar_drawing_id: null } })],
      repo_url: "https://github.com/test/test",
    });
    assert.match(html, /<main>/);
    assert.match(html, /<ul class="feed-list" data-feed-list>/);
    assert.match(html, /<article class="feed-card">/);
    assert.match(html, /<a class="feed-card-author-link" href="\/u\/alice">/);
    assert.match(html, /<span>alice<\/span>/);
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

  test("renders the avatar img inline next to the username when set", () => {
    const avatarId = "b".repeat(64);
    const html = renderHome({
      items: [
        item({ author: { username: "alice", avatar_drawing_id: avatarId } }),
      ],
      repo_url: "https://github.com/test/test",
    });
    assert.match(
      html,
      new RegExp(`<img class="avatar" src="/tiles/${avatarId}\\.gif"`),
    );
  });

  test("emits an infinite-scroll sentinel + observer script when paginated", () => {
    const html = renderHome({
      items: [item()],
      next_fragment_url: "/feed/items?cursor=foo",
      repo_url: "https://github.com/test/test",
    });
    assert.match(html, /data-feed-sentinel data-next="\/feed\/items\?cursor=foo"/);
    assert.match(html, /IntersectionObserver/);
    assert.match(html, /\[data-feed-list\]/);
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

  test("renders a Fork action linking to /draw?fork=<id>", () => {
    const id = "c".repeat(64);
    const html = renderFeedCard(item({ id }));
    assert.match(html, new RegExp(`<a class="feed-action" href="/draw\\?fork=${id}"`));
    assert.match(html, />Fork<\/span>/);
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
    assert.match(html, /<div class="feed-card-author">/);
    assert.match(html, /<div class="feed-card-main">/);
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
});

describe("renderFeedFragment", () => {
  test("returns just the cards (no <html>) and appends a sentinel when paginated", () => {
    const html = renderFeedFragment([item()], "/feed/items?cursor=x");
    assert.doesNotMatch(html, /<html/);
    assert.match(html, /<article class="feed-card">/);
    assert.match(html, /<li class="feed-sentinel" data-feed-sentinel data-next="\/feed\/items\?cursor=x">/);
  });

  test("omits the sentinel on the last page (next=null)", () => {
    const html = renderFeedFragment([item()], null);
    assert.doesNotMatch(html, /data-feed-sentinel/);
  });
});
