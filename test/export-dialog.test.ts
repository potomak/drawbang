import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  exportFilename,
  exportShareCaption,
  resolveOption,
} from "../src/export-dialog.js";
import type { VideoSupport } from "../src/editor/video.js";

const SUPPORT_NONE: VideoSupport = { mp4: { supported: false }, webm: { supported: false } };
const SUPPORT_WEBM_ONLY: VideoSupport = {
  mp4: { supported: false },
  webm: { supported: true, mimeType: "video/webm;codecs=vp9" },
};
const SUPPORT_MP4: VideoSupport = {
  mp4: { supported: true, codec: "avc1.42002a" },
  webm: { supported: true, mimeType: "video/webm;codecs=vp9" },
};

describe("resolveOption", () => {
  test("GIF is always available — every browser falls through to it", () => {
    const a = resolveOption("gif", SUPPORT_NONE);
    assert.equal(a.disabled, false);
    assert.deepEqual(a.produces, { container: "gif" });
    assert.match(a.label, /GIF/);
  });

  test("MP4 wins when both encoders are supported (Reels preset wants H.264)", () => {
    const r = resolveOption("reels", SUPPORT_MP4);
    assert.equal(r.disabled, false);
    assert.deepEqual(r.produces, { container: "video", format: "mp4", preset: "reels" });
    assert.match(r.label, /^MP4 —/);
    assert.match(r.label, /1080×1920/);
  });

  test("Falls back to WebM (labeled so) when MP4 isn't supported", () => {
    const s = resolveOption("square", SUPPORT_WEBM_ONLY);
    assert.equal(s.disabled, false);
    assert.deepEqual(s.produces, { container: "video", format: "webm", preset: "square" });
    assert.match(s.label, /^WebM —/);
    assert.match(s.label, /\(fallback\)/);
  });

  test("Disables the option when neither encoder is available", () => {
    const s = resolveOption("square", SUPPORT_NONE);
    assert.equal(s.disabled, true);
    assert.match(s.label, /unavailable/);
  });
});

describe("exportFilename", () => {
  test("uses the published id when present, capped at 12 chars", () => {
    const snap = {
      frames: [],
      activePalette: new Uint8Array(),
      delayMs: 200,
      size: 16,
      lastPublishedId: "deadbeef".repeat(8),
    };
    assert.equal(exportFilename(snap, "mp4"), "draw-deadbeefdead.mp4");
    assert.equal(exportFilename(snap, "gif"), "draw-deadbeefdead.gif");
  });

  test("uses a stable fallback slug for unpublished drafts", () => {
    const snap = {
      frames: [],
      activePalette: new Uint8Array(),
      delayMs: 200,
      size: 16,
      lastPublishedId: null,
    };
    assert.equal(exportFilename(snap, "webm"), "draw-draw.webm");
  });
});

describe("exportShareCaption", () => {
  test("ships the campaign hashtag — change here, not at call sites", () => {
    assert.equal(exportShareCaption(), "Made with Draw! #draw16");
  });
});
