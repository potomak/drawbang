import { strict as assert } from "node:assert";
import { test } from "node:test";
import catalog from "../config/merch.json" with { type: "json" };
import type { MerchCatalog } from "../merch/lambda.js";

const cat = catalog as MerchCatalog;

function find(id: string) {
  const p = cat.products.find((p) => p.id === id);
  assert.ok(p, `expected product ${id} in catalog`);
  return p;
}

test("Heavy Cotton Tee carries only S, M, L, XL, 2XL (no 3XL / 4XL)", () => {
  const tee = find("tee");
  const sizes = new Set(tee.variants.map((v) => v.size));
  assert.deepEqual(
    [...sizes].sort(),
    ["2XL", "L", "M", "S", "XL"],
    "tee sizes must be exactly S, M, L, XL, 2XL",
  );
});

test("Softstyle T-Shirt is in the catalog with XS through 2XL in Black + White", () => {
  const tee = find("tee-softstyle");
  assert.equal(tee.blueprint_id, 145);
  assert.equal(tee.print_provider_id, 99);
  const sizes = new Set(tee.variants.map((v) => v.size));
  for (const s of ["XS", "S", "M", "L", "XL", "2XL"]) {
    assert.ok(sizes.has(s), `Softstyle missing size ${s}`);
  }
  const colors = new Set(tee.variants.map((v) => v.color));
  assert.ok(colors.has("Black"));
  assert.ok(colors.has("White"));
  assert.equal(tee.variants.length, 12, "expected 6 sizes × 2 colors = 12 variants");
});

test("no variant in the catalog carries a legacy `label` field", () => {
  for (const product of cat.products) {
    for (const variant of product.variants) {
      assert.equal(
        (variant as unknown as { label?: string }).label,
        undefined,
        `${product.id} variant ${variant.id} still has a label field`,
      );
    }
  }
});

test("every variant has at least an id, base_cost_cents, retail_cents", () => {
  for (const product of cat.products) {
    for (const variant of product.variants) {
      assert.equal(typeof variant.id, "number");
      assert.equal(typeof variant.base_cost_cents, "number");
      assert.equal(typeof variant.retail_cents, "number");
    }
  }
});
