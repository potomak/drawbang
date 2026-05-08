import { strict as assert } from "node:assert";
import { test } from "node:test";
import mockups from "../config/mockups.json" with { type: "json" };
import merch from "../config/merch.json" with { type: "json" };

interface PlaceholderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MockupConfig {
  mockup_url: string;
  mockup_width: number;
  mockup_height: number;
  placeholders: PlaceholderRect[];
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
    assert.ok(
      Array.isArray(cfg.placeholders) && cfg.placeholders.length > 0,
      `${product.id}: placeholders must be a non-empty array`,
    );
  }
});

test("mockup placeholder rectangles fit inside the mockup canvas", () => {
  for (const [id, cfg] of Object.entries(m.products)) {
    cfg.placeholders.forEach((ph, i) => {
      const { x, y, width, height } = ph;
      assert.ok(x >= 0 && y >= 0, `${id}[${i}]: placeholder origin must be non-negative`);
      assert.ok(width > 0 && height > 0, `${id}[${i}]: placeholder dims must be positive`);
      assert.ok(
        x + width <= cfg.mockup_width,
        `${id}[${i}]: x+width (${x + width}) exceeds mockup_width (${cfg.mockup_width})`,
      );
      assert.ok(
        y + height <= cfg.mockup_height,
        `${id}[${i}]: y+height (${y + height}) exceeds mockup_height (${cfg.mockup_height})`,
      );
    });
  }
});

test("placeholder dims are divisible by 16 for clean pixel-art scaling", () => {
  // Not strictly required (the compositor rounds per-cell), but a nice
  // signal that the rect was chosen with the 16x16 source in mind.
  for (const [id, cfg] of Object.entries(m.products)) {
    cfg.placeholders.forEach((ph, i) => {
      assert.equal(ph.width % 16, 0, `${id}[${i}]: width not divisible by 16`);
      assert.equal(ph.height % 16, 0, `${id}[${i}]: height not divisible by 16`);
    });
  }
});
