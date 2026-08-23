import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { MemoryOrdersStore, type Order } from "../merch/orders.js";
import {
  handleAdminOrdersData,
  handleAdminOrdersPage,
  handleAdminOrderUpdate,
} from "../ingest/admin-orders-handler.js";

function order(overrides: Partial<Order> = {}): Order {
  return {
    order_id: overrides.order_id ?? "00000000-0000-4000-a000-000000000001",
    drawing_id: overrides.drawing_id ?? "a".repeat(64),
    frame: overrides.frame ?? 0,
    product_id: overrides.product_id ?? "tee",
    variant_id: overrides.variant_id ?? 18395,
    retail_cents: overrides.retail_cents ?? 2400,
    base_cost_cents: overrides.base_cost_cents ?? 1199,
    status: overrides.status ?? "pending",
    env: overrides.env ?? "prod",
    created_at: overrides.created_at ?? "2026-04-27T10:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-27T10:00:00.000Z",
    customer_email: overrides.customer_email ?? "buyer@example.com",
  };
}

describe("handleAdminOrdersPage", () => {
  test("returns the admin orders shell HTML fragment", async () => {
    const res = await handleAdminOrdersPage();
    assert.equal(res.status, 200);
    assert.match(res.body, /Admin — Orders/);
    assert.match(res.body, /data-admin-orders-page/);
    assert.equal(res.cacheControl, "private, no-store");
  });
});

describe("handleAdminOrdersData", () => {
  test("returns the inner fragment with a row per order, newest first", async () => {
    const store = new MemoryOrdersStore();
    await store.createOrder(order({ order_id: "00000000-0000-4000-a000-0000000000a1", created_at: "2026-04-27T12:00:00.000Z" }));
    await store.createOrder(order({ order_id: "00000000-0000-4000-a000-0000000000b2", created_at: "2026-04-27T10:00:00.000Z" }));

    const res = await handleAdminOrdersData({ ordersStore: store });
    assert.equal(res.status, 200);
    assert.match(res.body, /adm-orders-table/);
    const posA1 = res.body.indexOf("00000000");
    assert.ok(posA1 >= 0);
    // Newest order (12:00) should appear before older (10:00) — scanRecent sorts desc.
    const idxNewest = res.body.indexOf("00000000-0000-4000-a000-0000000000a1");
    const idxOlder = res.body.indexOf("00000000-0000-4000-a000-0000000000b2");
    assert.ok(idxNewest < idxOlder);
  });

  test("shows the empty state when no orders exist", async () => {
    const res = await handleAdminOrdersData({ ordersStore: new MemoryOrdersStore() });
    assert.equal(res.status, 200);
    assert.match(res.body, /No orders yet/);
  });
});

describe("handleAdminOrderUpdate", () => {
  test("bad JSON body → 400", async () => {
    const store = new MemoryOrdersStore();
    const res = await handleAdminOrderUpdate({ ordersStore: store }, "00000000-0000-4000-a000-000000000001", "{nope");
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "bad json body" });
  });

  test("missing status and env → 400", async () => {
    const store = new MemoryOrdersStore();
    await store.createOrder(order());
    const res = await handleAdminOrderUpdate({ ordersStore: store }, order().order_id, JSON.stringify({}));
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "provide status and/or env" });
  });

  test("bad status → 400 bad status", async () => {
    const store = new MemoryOrdersStore();
    await store.createOrder(order());
    const res = await handleAdminOrderUpdate({ ordersStore: store }, order().order_id, JSON.stringify({ status: "not_a_status" }));
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "bad status" });
  });

  test("bad env → 400", async () => {
    const store = new MemoryOrdersStore();
    await store.createOrder(order());
    const res = await handleAdminOrderUpdate({ ordersStore: store }, order().order_id, JSON.stringify({ env: "nope" }));
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "bad env: expected prod or sandbox" });
  });

  test("order not found → 404 on status update", async () => {
    const store = new MemoryOrdersStore();
    const res = await handleAdminOrderUpdate(
      { ordersStore: store },
      "00000000-0000-4000-a000-000000000099",
      JSON.stringify({ status: "shipped" }),
    );
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "order not found" });
  });

  test("order not found → 404 on env update", async () => {
    const store = new MemoryOrdersStore();
    const res = await handleAdminOrderUpdate(
      { ordersStore: store },
      "00000000-0000-4000-a000-000000000099",
      JSON.stringify({ env: "sandbox" }),
    );
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "order not found" });
  });

  test("status update → 200 with the updated order", async () => {
    const store = new MemoryOrdersStore();
    const id = "00000000-0000-4000-a000-000000000001";
    await store.createOrder(order({ order_id: id, status: "pending" }));
    const before = (await store.getOrder(id)) as Order;

    const res = await handleAdminOrderUpdate({ ordersStore: store }, id, JSON.stringify({ status: "shipped" }));
    assert.equal(res.status, 200);
    const updated = res.body as Order;
    assert.equal(updated.order_id, id);
    assert.equal(updated.status, "shipped");
    assert.notEqual(updated.updated_at, before.updated_at);

    const persisted = await store.getOrder(id);
    assert.equal(persisted?.status, "shipped");
  });

  test("env update → 200 and normalizes aliases", async () => {
    const store = new MemoryOrdersStore();
    const id = "00000000-0000-4000-a000-000000000002";
    await store.createOrder(order({ order_id: id, env: "prod" }));

    const cases: Array<[string, "prod" | "sandbox"]> = [
      ["prod", "prod"],
      ["PROD", "prod"],
      ["production", "prod"],
      ["live", "prod"],
      ["sandbox", "sandbox"],
      ["SANDBOX", "sandbox"],
      ["test", "sandbox"],
      ["dry-run", "sandbox"],
      ["dry_run", "sandbox"],
      ["  sandbox  ", "sandbox"],
    ];

    for (const [raw, expected] of cases) {
      const res = await handleAdminOrderUpdate({ ordersStore: store }, id, JSON.stringify({ env: raw }));
      assert.equal(res.status, 200, `env ${raw}`);
      assert.equal((res.body as Order).env, expected, `env ${raw} normalizes to ${expected}`);
    }
  });

  test("env update preserves status and vice versa", async () => {
    const store = new MemoryOrdersStore();
    const id = "00000000-0000-4000-a000-000000000003";
    await store.createOrder(order({ order_id: id, status: "paid", env: "prod" }));

    await handleAdminOrderUpdate({ ordersStore: store }, id, JSON.stringify({ env: "sandbox" }));
    assert.equal((await store.getOrder(id))?.env, "sandbox");
    assert.equal((await store.getOrder(id))?.status, "paid");

    await handleAdminOrderUpdate({ ordersStore: store }, id, JSON.stringify({ status: "in_production" }));
    assert.equal((await store.getOrder(id))?.status, "in_production");
    assert.equal((await store.getOrder(id))?.env, "sandbox");
  });

  test("both status and env in one body update both fields", async () => {
    const store = new MemoryOrdersStore();
    const id = "00000000-0000-4000-a000-000000000004";
    await store.createOrder(order({ order_id: id, status: "pending", env: "prod" }));

    const res = await handleAdminOrderUpdate({ ordersStore: store }, id, JSON.stringify({ status: "shipped", env: "sandbox" }));
    assert.equal(res.status, 200);
    // Returns the last mutation's result (the env update), which should reflect both changes.
    const body = res.body as Order;
    assert.equal(body.env, "sandbox");
    // Persisted row should have both mutations.
    const persisted = await store.getOrder(id);
    assert.equal(persisted?.status, "shipped");
    assert.equal(persisted?.env, "sandbox");
  });

  test("accepts every valid OrderStatus", async () => {
    const statuses = ["pending", "paid", "submitted", "in_production", "shipped", "delivered", "failed", "refunded"] as const;
    for (const s of statuses) {
      const store = new MemoryOrdersStore();
      const id = "00000000-0000-4000-a000-000000000010";
      await store.createOrder(order({ order_id: id, status: "pending" }));
      const res = await handleAdminOrderUpdate({ ordersStore: store }, id, JSON.stringify({ status: s }));
      assert.equal(res.status, 200, `status ${s}`);
      assert.equal((res.body as Order).status, s);
    }
  });
});
