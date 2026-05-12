import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { FsStorage } from "../ingest/storage.js";
import { build, productCardsFromCounters, relativeTimeLabel } from "../builder/build.js";
import type { ProductCountersSource } from "../builder/build.js";
import type { MerchCatalog } from "../merch/lambda.js";
import type { ProductCounter } from "../merch/product-counters.js";

const CATALOG: MerchCatalog = {
  products: [
    {
      id: "tee",
      name: "Unisex Heavy Cotton Tee",
      blueprint_id: 6,
      print_provider_id: 99,
      print_area_px: { width: 3951, height: 4919 },
      shipping_cents: 500,
      variants: [
        { id: 1, label: "S/Black", base_cost_cents: 1150, retail_cents: 2400 },
        // Cheaper "from $" anchor — the join should pick this one.
        { id: 2, label: "M/Black", base_cost_cents: 1100, retail_cents: 2200 },
      ],
    },
    {
      id: "mug",
      name: "Ceramic Mug",
      blueprint_id: 70,
      print_provider_id: 1,
      print_area_px: { width: 2475, height: 1155 },
      shipping_cents: 800,
      variants: [
        { id: 10, label: "11oz", base_cost_cents: 800, retail_cents: 1600 },
      ],
    },
  ],
};

function makeCounter(overrides: Partial<ProductCounter> = {}): ProductCounter {
  return {
    pk: "x#tee",
    drawing_id: "a".repeat(64),
    product_id: "tee",
    count: 1,
    first_ordered_at: "2026-05-01T00:00:00.000Z",
    last_ordered_at: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function stubSource(counters: ProductCounter[]): ProductCountersSource {
  return { listAll: async () => counters };
}

async function makeStorage(): Promise<{ root: string; storage: FsStorage }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drawbang-products-"));
  return { root, storage: new FsStorage(root) };
}

test("productCardsFromCounters: 'from $X' uses the cheapest variant in the catalog", () => {
  const cards = productCardsFromCounters(
    [makeCounter()],
    CATALOG,
    new Date("2026-05-11T00:00:00.000Z"),
  );
  assert.equal(cards.length, 1);
  // tee has variants 2400 and 2200; 2200 is the floor.
  assert.equal(cards[0].from_dollars, "22.00");
});

test("productCardsFromCounters: count=0 counters are excluded", () => {
  const cards = productCardsFromCounters(
    [makeCounter({ count: 0 })],
    CATALOG,
    new Date(),
  );
  assert.deepEqual(cards, []);
});

test("productCardsFromCounters: counters for unknown product_id are dropped (catalog shrinkage tolerance)", () => {
  const cards = productCardsFromCounters(
    [makeCounter({ product_id: "ghost-product" })],
    CATALOG,
    new Date(),
  );
  assert.deepEqual(cards, []);
});

test("productCardsFromCounters: sorts count desc, ties broken by last_ordered_at desc", () => {
  const did1 = "1".repeat(64);
  const did2 = "2".repeat(64);
  const did3 = "3".repeat(64);
  const did4 = "4".repeat(64);
  const cards = productCardsFromCounters(
    [
      makeCounter({ drawing_id: did1, product_id: "tee", count: 5, last_ordered_at: "2026-05-01T00:00:00.000Z" }),
      makeCounter({ drawing_id: did2, product_id: "tee", count: 5, last_ordered_at: "2026-05-10T00:00:00.000Z" }),
      makeCounter({ drawing_id: did3, product_id: "tee", count: 9, last_ordered_at: "2026-04-01T00:00:00.000Z" }),
      makeCounter({ drawing_id: did4, product_id: "mug", count: 1, last_ordered_at: "2026-05-11T00:00:00.000Z" }),
    ],
    CATALOG,
    new Date("2026-05-12T00:00:00.000Z"),
  );
  assert.deepEqual(
    cards.map((c) => c.drawing_id),
    [did3, did2, did1, did4],
    "count=9 first; then the count=5 tied pair in recency desc; then count=1",
  );
});

test("relativeTimeLabel: future timestamps return null (clock skew safety)", () => {
  const now = new Date("2026-05-11T00:00:00.000Z");
  assert.equal(relativeTimeLabel("2026-05-12T00:00:00.000Z", now), null);
});

test("relativeTimeLabel: bucketed minutes/hours/days/months", () => {
  const now = new Date("2026-05-11T12:00:00.000Z");
  assert.equal(relativeTimeLabel("2026-05-11T11:59:59.000Z", now), "just now");
  assert.equal(relativeTimeLabel("2026-05-11T11:30:00.000Z", now), "30 min ago");
  assert.equal(relativeTimeLabel("2026-05-11T08:00:00.000Z", now), "4 hours ago");
  assert.equal(relativeTimeLabel("2026-05-08T12:00:00.000Z", now), "3 days ago");
  assert.equal(relativeTimeLabel("2026-03-11T12:00:00.000Z", now), "2 months ago");
});

test("build writes public/products.html when counters + catalog are provided", async () => {
  const { root, storage } = await makeStorage();
  await build({
    storage,
    publicBaseUrl: "https://drawbang.example",
    productCountersSource: stubSource([makeCounter({ count: 2 })]),
    merchCatalog: CATALOG,
    now: () => new Date("2026-05-11T00:00:00.000Z"),
  });
  const html = await fs.readFile(path.join(root, "public/products.html"), "utf8");
  assert.match(html, /products/);
  assert.match(html, /Unisex Heavy Cotton Tee/);
  assert.match(html, /data-drawing-id="a{64}"/);
});

test("build paginates /products at PER_PAGE=36, page 1 to /products.html, pages 2+ to /products/p/N.html", async () => {
  const { root, storage } = await makeStorage();
  const counters: ProductCounter[] = [];
  // 40 unique (drawing × product) tuples: 36 on page 1, 4 on page 2.
  for (let i = 0; i < 40; i++) {
    const did = i.toString(16).padStart(64, "0");
    counters.push(makeCounter({
      drawing_id: did,
      product_id: "tee",
      pk: `${did}#tee`,
      // Vary count so the sort is deterministic and easy to assert.
      count: 100 - i,
      last_ordered_at: `2026-05-${String(11 - (i % 10)).padStart(2, "0")}T00:00:00.000Z`,
    }));
  }
  await build({
    storage,
    publicBaseUrl: "https://drawbang.example",
    productCountersSource: stubSource(counters),
    merchCatalog: CATALOG,
    now: () => new Date("2026-05-12T00:00:00.000Z"),
  });
  const p1 = await fs.readFile(path.join(root, "public/products.html"), "utf8");
  const p2 = await fs.readFile(path.join(root, "public/products/p/2.html"), "utf8");
  // page 1 has 36 cards; page 2 has 4.
  assert.equal((p1.match(/class="product-card"/g) ?? []).length, 36);
  assert.equal((p2.match(/class="product-card"/g) ?? []).length, 4);
  // Highest-count card (count=100, drawing 00...0) lands on page 1.
  const firstDid = "0".repeat(64);
  assert.ok(p1.includes(`data-drawing-id="${firstDid}"`));
  // Lowest-count card (count=61, drawing 00...27) lands on page 2.
  const lastDid = (39).toString(16).padStart(64, "0");
  assert.ok(p2.includes(`data-drawing-id="${lastDid}"`));
  // No PII surfaces (defensive — emails/addresses are never on counter rows).
  assert.ok(!p1.includes("@"));
});

test("build skips /products surface when no data source is wired up (local dev)", async () => {
  // Non-prod (e.g. local dev against FsStorage) doesn't provide a counter
  // store. Skip writing the file entirely so `npm run builder` against a
  // bare directory doesn't emit a misleading "no merch yet" page.
  const { root, storage } = await makeStorage();
  await build({
    storage,
    publicBaseUrl: "https://drawbang.example",
    merchCatalog: CATALOG,
  });
  await assert.rejects(() => fs.stat(path.join(root, "public/products.html")));
});

test("build emits an empty-state /products.html when counters table is empty", async () => {
  // The prod-deploy case before any order has reached `submitted`. The
  // CloudFront/S3 origin returns 403 for missing keys, so we must always
  // emit page 1, even if it's empty.
  const { root, storage } = await makeStorage();
  await build({
    storage,
    publicBaseUrl: "https://drawbang.example",
    productCountersSource: stubSource([]),
    merchCatalog: CATALOG,
  });
  const html = await fs.readFile(path.join(root, "public/products.html"), "utf8");
  assert.match(html, /No merch ordered yet/);
  // No card markup leaks into the empty state.
  assert.ok(!html.includes("product-card"));
});

test("build emits an empty-state /products.html when the join produces no cards (catalog shrunk away)", async () => {
  const { root, storage } = await makeStorage();
  await build({
    storage,
    publicBaseUrl: "https://drawbang.example",
    productCountersSource: stubSource([makeCounter({ product_id: "no-such-product" })]),
    merchCatalog: CATALOG,
  });
  const html = await fs.readFile(path.join(root, "public/products.html"), "utf8");
  assert.match(html, /No merch ordered yet/);
});
