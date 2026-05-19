import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..");

async function readHome(): Promise<string> {
  return fs.readFile(path.join(REPO, "index.html"), "utf8");
}

describe("home page OG / meta tags (index.html)", () => {
  test("emits a name=description matching the agreed copy", async () => {
    const html = await readHome();
    assert.match(
      html,
      /<meta name="description" content="A 16×16 pixel-art editor"\s*\/>/,
    );
  });

  test("emits a canonical link to the public home URL", async () => {
    const html = await readHome();
    assert.match(
      html,
      /<link rel="canonical" href="https:\/\/pixel\.drawbang\.com\/"\s*\/>/,
    );
  });

  test("emits the full og:* suite with absolute URLs", async () => {
    const html = await readHome();
    assert.match(html, /<meta property="og:type" content="website"/);
    assert.match(html, /<meta property="og:site_name" content="Draw!"/);
    assert.match(html, /<meta property="og:title" content="Draw!"/);
    assert.match(html, /<meta property="og:description" content="A 16×16 pixel-art editor"/);
    assert.match(html, /<meta property="og:url" content="https:\/\/pixel\.drawbang\.com\/"/);
    assert.match(
      html,
      /<meta property="og:image" content="https:\/\/pixel\.drawbang\.com\/og-logo\.png"/,
    );
    assert.match(html, /<meta property="og:image:type" content="image\/png"/);
    assert.match(html, /<meta property="og:image:width" content="320"/);
    assert.match(html, /<meta property="og:image:height" content="320"/);
  });

  test("emits twitter:card=summary for the 1:1 square preview", async () => {
    const html = await readHome();
    assert.match(html, /<meta name="twitter:card" content="summary"/);
  });

  test("ships static/og-logo.png at 320x320 PNG", async () => {
    const png = await fs.readFile(path.join(REPO, "static/og-logo.png"));
    // PNG magic.
    assert.equal(png[0], 0x89);
    assert.equal(png[1], 0x50);
    assert.equal(png[2], 0x4e);
    assert.equal(png[3], 0x47);
    // IHDR width/height live at bytes 16-23 in big-endian.
    const w = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19];
    const h = (png[20] << 24) | (png[21] << 16) | (png[22] << 8) | png[23];
    assert.equal(w, 320);
    assert.equal(h, 320);
  });
});

describe("privacy disclosure (#163 ported to GA / Pixel reality)", () => {
  test("privacy.html exists and uses the chrome marker pattern", async () => {
    const html = await fs.readFile(path.join(REPO, "privacy.html"), "utf8");
    assert.match(html, /<!--CHROME:HEADER-->/);
    assert.match(html, /<!--CHROME:FOOTER-->/);
    assert.match(html, /<title>Draw! · Privacy<\/title>/);
  });

  test("privacy.html discloses analytics + honours Do Not Track", async () => {
    const html = await fs.readFile(path.join(REPO, "privacy.html"), "utf8");
    assert.match(html, /analytics/i);
    assert.match(html, /Do Not Track/);
  });

  test("privacy.html exposes the toggle button + status hooks the script wires", async () => {
    const html = await fs.readFile(path.join(REPO, "privacy.html"), "utf8");
    assert.match(html, /id="pv-toggle"/);
    assert.match(html, /id="pv-status-text"/);
    assert.match(html, /id="pv-reload-note"/);
  });

  test("renderFooter() links to /privacy on every page that uses the chrome", async () => {
    const { renderFooter } = await import("../src/layout/chrome.js");
    const html = renderFooter({ repoUrl: "https://example.test" });
    assert.match(html, /<a class="ftr-privacy" href="\/privacy">Privacy<\/a>/);
  });
});
