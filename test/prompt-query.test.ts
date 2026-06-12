import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { promptFromQuery, promptGuidanceHint } from "../src/prompt-query.js";
import { promptForDate, type Prompt } from "../config/prompts.js";

// Noon-ET instant, safely away from any ET day boundary (and from the
// shipped pre-launch OVERRIDES entry).
const NOW = new Date(Date.UTC(2026, 5, 20, 16, 0, 0));
const TODAY = promptForDate(NOW);
const TOMORROW = promptForDate(new Date(NOW.getTime() + 86_400_000));

describe("promptFromQuery", () => {
  test("accepts today's slug and returns the full prompt", () => {
    const got = promptFromQuery(`?prompt=${TODAY.slug}`, NOW);
    assert.equal(got?.slug, TODAY.slug);
    assert.equal(got?.title, TODAY.title);
  });

  test("coexists with ?fork= (remixing today's prompt is legal)", () => {
    const got = promptFromQuery(`?fork=${"a".repeat(64)}&prompt=${TODAY.slug}`, NOW);
    assert.equal(got?.slug, TODAY.slug);
  });

  test("rejects a real prompt slug that isn't today's", () => {
    // Rotation advances daily, so tomorrow's slug is a known-stale link.
    assert.notEqual(TOMORROW.slug, TODAY.slug);
    assert.equal(promptFromQuery(`?prompt=${TOMORROW.slug}`, NOW), null);
  });

  test("rejects slugs that fail PROMPT_SLUG_RE", () => {
    for (const bad of [
      "Tiny-Ghost", // uppercase
      "sl ug", // space
      "slug!", // punctuation
      "x".repeat(33), // too long
      "", // empty
    ]) {
      assert.equal(promptFromQuery(`?prompt=${encodeURIComponent(bad)}`, NOW), null);
    }
  });

  test("rejects a well-formed slug that names no prompt", () => {
    assert.equal(promptFromQuery("?prompt=not-a-real-prompt-slug", NOW), null);
  });

  test("no chip without a ?prompt= param", () => {
    assert.equal(promptFromQuery("", NOW), null);
    assert.equal(promptFromQuery("?fork=abc123", NOW), null);
  });
});

describe("promptGuidanceHint", () => {
  test("null when the prompt has no rules", () => {
    const plain: Prompt = { slug: "campfire", title: "Campfire", blurb: "x" };
    assert.equal(promptGuidanceHint(plain), null);
  });

  test("maxColors rule", () => {
    const p: Prompt = { slug: "s", title: "T", blurb: "b", rules: { maxColors: 4 } };
    assert.equal(promptGuidanceHint(p), "try ≤4 colors");
  });

  test("size rule", () => {
    const p: Prompt = { slug: "s", title: "T", blurb: "b", rules: { size: 8 } };
    assert.equal(promptGuidanceHint(p), "try 8×8");
  });

  test("both rules join with a separator", () => {
    const p: Prompt = {
      slug: "s",
      title: "T",
      blurb: "b",
      rules: { maxColors: 3, size: 8 },
    };
    assert.equal(promptGuidanceHint(p), "try ≤3 colors · try 8×8");
  });
});
