import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PrintifyClient, PrintifyError } from "../merch/printify.js";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface StubResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function makeFetch(calls: RecordedCall[], responses: StubResponse[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = init?.body;
    const parsedBody =
      typeof rawBody === "string" ? JSON.parse(rawBody) : undefined;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: parsedBody,
    });

    const r = responses.shift();
    if (!r) throw new Error(`unexpected fetch call to ${url}`);
    return new Response(
      r.body !== undefined ? JSON.stringify(r.body) : null,
      {
        status: r.status,
        headers: { "Content-Type": "application/json", ...(r.headers ?? {}) },
      },
    );
  }) as typeof fetch;
}

const noSleep = async () => {};

function makeClient(calls: RecordedCall[], responses: StubResponse[]) {
  return new PrintifyClient({
    token: "tok_abc",
    shopId: "shop_42",
    fetchImpl: makeFetch(calls, responses),
    sleepImpl: noSleep,
  });
}

test("uploadImage posts base64 contents to /uploads/images.json", async () => {
  const calls: RecordedCall[] = [];
  const client = makeClient(calls, [
    { status: 200, body: { id: "img_1", preview_url: "https://p.example/1.png" } },
  ]);

  const png = new Uint8Array([1, 2, 3, 4]);
  const out = await client.uploadImage("hello.png", png);

  assert.deepEqual(out, { id: "img_1", preview_url: "https://p.example/1.png" });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.method, "POST");
  assert.equal(c.url, "https://api.printify.com/v1/uploads/images.json");
  assert.equal(c.headers.Authorization, "Bearer tok_abc");
  assert.equal(c.headers["Content-Type"], "application/json");
  assert.deepEqual(c.body, {
    file_name: "hello.png",
    contents: Buffer.from(png).toString("base64"),
  });
});

test("createProduct posts to the shop products endpoint with the supplied payload", async () => {
  const calls: RecordedCall[] = [];
  const client = makeClient(calls, [{ status: 200, body: { id: "prod_99" } }]);

  const out = await client.createProduct({
    title: "Pixel tee",
    description: "16x16 pixel art on a tee",
    blueprint_id: 6,
    print_provider_id: 99,
    variants: [{ id: 18395, price: 2400, is_enabled: true }],
    print_areas: [
      {
        variant_ids: [18395],
        placeholders: [
          {
            position: "front",
            images: [{ id: "img_1", x: 0.5, y: 0.5, scale: 1, angle: 0 }],
          },
        ],
      },
    ],
  });

  assert.deepEqual(out, { id: "prod_99" });
  assert.equal(calls[0].url, "https://api.printify.com/v1/shops/shop_42/products.json");
  assert.equal(calls[0].method, "POST");
  const b = calls[0].body as { title: string; variants: { id: number }[] };
  assert.equal(b.title, "Pixel tee");
  assert.equal(b.variants[0].id, 18395);
});

test("createOrder posts to the shop orders endpoint with our external_id", async () => {
  const calls: RecordedCall[] = [];
  const client = makeClient(calls, [{ status: 200, body: { id: "po_1", status: "pending" } }]);

  const out = await client.createOrder({
    external_id: "ord_42",
    label: "drawbang ord_42",
    line_items: [{ product_id: "prod_99", variant_id: 18395, quantity: 1 }],
    shipping_method: 1,
    is_printify_express: false,
    send_shipping_notification: false,
    address_to: {
      first_name: "A", last_name: "B", email: "a@b.example",
      country: "US", region: "CA", address1: "1 Main", city: "SF", zip: "94110",
    },
  });

  assert.deepEqual(out, { id: "po_1", status: "pending" });
  assert.equal(calls[0].url, "https://api.printify.com/v1/shops/shop_42/orders.json");
  const b = calls[0].body as { external_id: string };
  assert.equal(b.external_id, "ord_42");
});

test("getOrder GETs the shop order endpoint without a body", async () => {
  const calls: RecordedCall[] = [];
  const client = makeClient(calls, [{ status: 200, body: { id: "po_1", status: "fulfilled" } }]);

  const out = await client.getOrder("po_1");

  assert.deepEqual(out, { id: "po_1", status: "fulfilled" });
  assert.equal(calls[0].url, "https://api.printify.com/v1/shops/shop_42/orders/po_1.json");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].headers["Content-Type"], undefined);
});

test("retries 429 + Retry-After then succeeds", async () => {
  const calls: RecordedCall[] = [];
  let sleptMs: number[] = [];
  const sleep = async (ms: number) => { sleptMs.push(ms); };
  const client = new PrintifyClient({
    token: "tok",
    shopId: "shop_42",
    fetchImpl: makeFetch(calls, [
      { status: 429, headers: { "Retry-After": "2" }, body: { error: "slow down" } },
      { status: 200, body: { id: "img_1", preview_url: "u" } },
    ]),
    sleepImpl: sleep,
  });

  const out = await client.uploadImage("a.png", new Uint8Array([0]));
  assert.deepEqual(out, { id: "img_1", preview_url: "u" });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleptMs, [2000]); // 2s from Retry-After, not the default 500ms
});

test("retries 5xx on the default backoff schedule then succeeds", async () => {
  const calls: RecordedCall[] = [];
  const sleptMs: number[] = [];
  const client = new PrintifyClient({
    token: "tok",
    shopId: "shop_42",
    fetchImpl: makeFetch(calls, [
      { status: 503, body: { error: "down" } },
      { status: 502, body: { error: "down" } },
      { status: 200, body: { id: "po_1", status: "pending" } },
    ]),
    sleepImpl: async (ms) => { sleptMs.push(ms); },
  });

  const out = await client.getOrder("po_1");
  assert.deepEqual(out, { id: "po_1", status: "pending" });
  assert.equal(calls.length, 3);
  assert.deepEqual(sleptMs, [500, 1000]);
});

test("4xx (non-429) throws PrintifyError immediately, no retries", async () => {
  const calls: RecordedCall[] = [];
  const sleptMs: number[] = [];
  const client = new PrintifyClient({
    token: "tok",
    shopId: "shop_42",
    fetchImpl: makeFetch(calls, [{ status: 400, body: { error: "bad input" } }]),
    sleepImpl: async (ms) => { sleptMs.push(ms); },
  });

  await assert.rejects(
    () => client.uploadImage("a.png", new Uint8Array([0])),
    (err: unknown) => {
      assert.ok(err instanceof PrintifyError);
      assert.equal(err.status, 400);
      assert.deepEqual(err.body, { error: "bad input" });
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(sleptMs, []);
});

test("gives up after exhausting the retry schedule and throws PrintifyError", async () => {
  const calls: RecordedCall[] = [];
  const responses = Array.from({ length: 5 }, () => ({ status: 503 as const, body: { error: "down" } }));
  const client = new PrintifyClient({
    token: "tok",
    shopId: "shop_42",
    fetchImpl: makeFetch(calls, responses),
    sleepImpl: noSleep,
  });

  await assert.rejects(
    () => client.getOrder("po_1"),
    (err: unknown) => err instanceof PrintifyError && err.status === 503,
  );
  // initial attempt + 4 retries = 5 calls
  assert.equal(calls.length, 5);
});
