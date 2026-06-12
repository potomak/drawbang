import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  etDateString,
  OVERRIDES,
  PROMPT_SLUG_RE,
  PROMPTS,
  PROMPTS_EPOCH_ET,
  promptBySlug,
  promptForDate,
} from "../config/prompts.js";

describe("etDateString", () => {
  test("spring-forward boundary (2026-03-08, EST -> EDT)", () => {
    // 06:59Z = 1:59 AM EST; 07:01Z = 3:01 AM EDT (2 AM never happens).
    assert.equal(etDateString(new Date("2026-03-08T06:59:00Z")), "2026-03-08");
    assert.equal(etDateString(new Date("2026-03-08T07:01:00Z")), "2026-03-08");
  });

  test("fall-back boundary (2026-11-01, EDT -> EST)", () => {
    // 05:59Z = 1:59 AM EDT; 06:01Z = 1:01 AM EST (1 AM happens twice).
    assert.equal(etDateString(new Date("2026-11-01T05:59:00Z")), "2026-11-01");
    assert.equal(etDateString(new Date("2026-11-01T06:01:00Z")), "2026-11-01");
    // After fall-back ET is UTC-5, so the day flips at 05:00Z.
    assert.equal(etDateString(new Date("2026-11-02T04:59:00Z")), "2026-11-01");
    assert.equal(etDateString(new Date("2026-11-02T05:01:00Z")), "2026-11-02");
  });

  test("UTC midnight is still the previous day in ET", () => {
    assert.equal(etDateString(new Date("2026-06-20T00:30:00Z")), "2026-06-19");
  });
});

describe("promptForDate rotation", () => {
  // Noon-ET instants, safely away from any day boundary.
  const noonEt = (y: number, monthIndex: number, day: number) =>
    new Date(Date.UTC(y, monthIndex, day, 16, 0, 0));

  test("epoch day is theme 0 and the same date always yields the same prompt", () => {
    const epochDay = noonEt(2026, 5, 15);
    assert.equal(etDateString(epochDay), PROMPTS_EPOCH_ET);
    assert.equal(promptForDate(epochDay).slug, PROMPTS[0].slug);
    assert.equal(promptForDate(epochDay), promptForDate(epochDay));
    // Different instants within one ET day agree too.
    const earlyEt = new Date("2026-06-20T04:01:00Z"); // 00:01 EDT Jun 20
    const lateEt = new Date("2026-06-21T03:59:00Z"); // 23:59 EDT Jun 20
    assert.equal(promptForDate(earlyEt), promptForDate(lateEt));
  });

  test("consecutive ET days advance exactly one theme", () => {
    for (let i = 0; i < PROMPTS.length; i++) {
      assert.equal(promptForDate(noonEt(2026, 5, 15 + i)).slug, PROMPTS[i].slug);
    }
  });

  test("day 21 wraps back to theme 0", () => {
    assert.equal(
      promptForDate(noonEt(2026, 5, 15 + PROMPTS.length)).slug,
      PROMPTS[0].slug,
    );
  });

  test("pre-epoch dates still return a prompt (negative-mod guard)", () => {
    // 13 days before epoch: -13 mod 21 must normalize to 8, not -13.
    assert.equal(promptForDate(noonEt(2026, 5, 2)).slug, PROMPTS[8].slug);
    const farPast = promptForDate(new Date("2020-01-01T12:00:00Z"));
    assert.ok(PROMPTS.includes(farPast));
  });
});

describe("promptForDate overrides", () => {
  test("override wins over rotation for its date; neighbors unaffected", () => {
    assert.equal(OVERRIDES["2026-06-01"], "tiny-ghost");
    // Rotation alone would land 14 days pre-epoch on theme 7.
    assert.equal(promptForDate(new Date("2026-06-01T16:00:00Z")).slug, "tiny-ghost");
    assert.notEqual("tiny-ghost", PROMPTS[7].slug);
    assert.equal(promptForDate(new Date("2026-05-31T16:00:00Z")).slug, PROMPTS[6].slug);
    assert.equal(promptForDate(new Date("2026-06-02T16:00:00Z")).slug, PROMPTS[8].slug);
  });

  test("every override entry is well-formed and resolvable", () => {
    for (const [day, slug] of Object.entries(OVERRIDES)) {
      assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(promptBySlug(slug), `override for ${day} points at unknown slug ${slug}`);
    }
  });
});

describe("PROMPTS catalog", () => {
  test("21 themes; slugs match PROMPT_SLUG_RE and are unique", () => {
    assert.equal(PROMPTS.length, 21);
    for (const p of PROMPTS) {
      assert.match(p.slug, PROMPT_SLUG_RE);
      assert.ok(p.title.length > 0);
      assert.ok(p.blurb.length > 0);
    }
    assert.equal(new Set(PROMPTS.map((p) => p.slug)).size, PROMPTS.length);
  });

  test("promptBySlug round-trips and returns null for unknowns", () => {
    for (const p of PROMPTS) assert.equal(promptBySlug(p.slug), p);
    assert.equal(promptBySlug("not-a-theme"), null);
    assert.equal(promptBySlug(""), null);
  });
});
