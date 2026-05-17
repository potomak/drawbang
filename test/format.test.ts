import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatDuration } from "../src/format.js";

test("formatDuration: zero and sub-minute", () => {
  assert.equal(formatDuration(0), "0 seconds");
  assert.equal(formatDuration(1), "1 second");
  assert.equal(formatDuration(5), "5 seconds");
  assert.equal(formatDuration(59), "59 seconds");
});

test("formatDuration: minutes only and minutes + seconds", () => {
  assert.equal(formatDuration(60), "1 minute");
  assert.equal(formatDuration(65), "1 minute and 5 seconds");
  assert.equal(formatDuration(120), "2 minutes");
  assert.equal(formatDuration(803), "13 minutes and 23 seconds");
});

test("formatDuration: hours drop the seconds tail", () => {
  assert.equal(formatDuration(3600), "1 hour");
  assert.equal(formatDuration(3905), "1 hour and 5 minutes");
  assert.equal(formatDuration(7200), "2 hours");
  assert.equal(formatDuration(7325), "2 hours and 2 minutes");
});

test("formatDuration: clamps negatives and rounds fractions", () => {
  assert.equal(formatDuration(-10), "0 seconds");
  assert.equal(formatDuration(59.4), "59 seconds");
  assert.equal(formatDuration(59.6), "1 minute");
});
