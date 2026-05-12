import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pickProductFromQuery } from "../src/merch-query.js";

const PRODUCTS = [
  { id: "tee" },
  { id: "mug" },
  { id: "sticker-sheet" },
] as const;

test("pickProductFromQuery returns the matching product when the id is in the catalog", () => {
  assert.deepEqual(pickProductFromQuery(PRODUCTS, "tee"), { id: "tee" });
  assert.deepEqual(pickProductFromQuery(PRODUCTS, "mug"), { id: "mug" });
  assert.deepEqual(pickProductFromQuery(PRODUCTS, "sticker-sheet"), { id: "sticker-sheet" });
});

test("pickProductFromQuery returns null for an unknown product id (silent fallback)", () => {
  // /products may deep-link a product that's since been removed from the
  // catalog. Returning null lets the merch page render normally instead of
  // throwing an error.
  assert.equal(pickProductFromQuery(PRODUCTS, "ghost"), null);
});

test("pickProductFromQuery returns null when the query param is missing", () => {
  assert.equal(pickProductFromQuery(PRODUCTS, null), null);
  assert.equal(pickProductFromQuery(PRODUCTS, undefined), null);
});

test("pickProductFromQuery handles an empty product list", () => {
  assert.equal(pickProductFromQuery([], "tee"), null);
});

test("pickProductFromQuery preserves richer product fields (generic over { id: string })", () => {
  const richer = [
    { id: "tee", name: "Tee", price: 2400 },
    { id: "mug", name: "Mug", price: 1600 },
  ];
  const picked = pickProductFromQuery(richer, "mug");
  assert.deepEqual(picked, { id: "mug", name: "Mug", price: 1600 });
});
