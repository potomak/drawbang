import { strict as assert } from "node:assert";
import { test } from "node:test";
import mockups from "../config/mockups.json" with { type: "json" };
import merch from "../config/merch.json" with { type: "json" };

interface MockupConfig {
  mockup_url: string;
  mockup_width: number;
  mockup_height: number;
  placeholder: { x: number; y: number; width: number; height: number };
}

interface MockupsFile {
  products: Record<string, MockupConfig>;
}

const m = mockups as MockupsFile;

test("every product in config/merch.json has a corresponding mockup config", () => {
  for (const product of merch.products) {
    const cfg = m.products[product.id];
    assert.ok(cfg, `missing mockup config for product ${product.id}`);
    assert.ok(cfg.mockup_url.startsWith("/"), "mockup_url should be a root-relative path");
    assert.ok(cfg.mockup_width > 0 && cfg.mockup_height > 0);
  }
});

test("mockup placeholder rectangles fit inside the mockup canvas", () => {
  for (const [id, cfg] of Object.entries(m.products)) {
    const { x, y, width, height } = cfg.placeholder;
    assert.ok(x >= 0 && y >= 0, `${id}: placeholder origin must be non-negative`);
    assert.ok(width > 0 && height > 0, `${id}: placeholder dims must be positive`);
    assert.ok(
      x + width <= cfg.mockup_width,
      `${id}: placeholder x+width (${x + width}) exceeds mockup_width (${cfg.mockup_width})`,
    );
    assert.ok(
      y + height <= cfg.mockup_height,
      `${id}: placeholder y+height (${y + height}) exceeds mockup_height (${cfg.mockup_height})`,
    );
  }
});

test("placeholder dims are divisible by 16 for clean pixel-art scaling", () => {
  // Not strictly required (the compositor rounds per-cell), but a nice
  // signal that the rect was chosen with the 16x16 source in mind.
  for (const [id, cfg] of Object.entries(m.products)) {
    assert.equal(cfg.placeholder.width % 16, 0, `${id}: placeholder.width not divisible by 16`);
    assert.equal(cfg.placeholder.height % 16, 0, `${id}: placeholder.height not divisible by 16`);
  }
});
