import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Order, OrderStatus } from "../merch/orders.js";
import { STATUS_GSI_NAME } from "../merch/orders.js";
import {
  aggregateCounters,
  backfillProductCounters,
  COUNTED_STATUSES,
  makeListOrdersByStatus,
  makePutCounters,
} from "../scripts/backfill-product-counters.js";
import { counterPk, type ProductCounter } from "../merch/product-counters.js";

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    order_id: "ord_x",
    drawing_id: "a".repeat(64),
    frame: 0,
    product_id: "tee",
    variant_id: 18395,
    retail_cents: 2400,
    base_cost_cents: 1199,
    status: "submitted",
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

test("aggregateCounters: empty input returns []", () => {
  assert.deepEqual(aggregateCounters([]), []);
});

test("aggregateCounters: single order produces one row with count=1, first==last==created_at", () => {
  const o = makeOrder({ created_at: "2026-03-15T12:00:00.000Z" });
  const out = aggregateCounters([o]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    pk: counterPk(o.drawing_id, o.product_id),
    drawing_id: o.drawing_id,
    product_id: o.product_id,
    count: 1,
    first_ordered_at: "2026-03-15T12:00:00.000Z",
    last_ordered_at: "2026-03-15T12:00:00.000Z",
  });
});

test("aggregateCounters: groups by (drawing_id, product_id) and tracks min/max created_at", () => {
  const did = "b".repeat(64);
  const orders: Order[] = [
    makeOrder({ order_id: "o1", drawing_id: did, product_id: "tee", created_at: "2026-04-05T00:00:00.000Z" }),
    makeOrder({ order_id: "o2", drawing_id: did, product_id: "tee", created_at: "2026-04-01T00:00:00.000Z" }),
    makeOrder({ order_id: "o3", drawing_id: did, product_id: "tee", created_at: "2026-04-10T00:00:00.000Z" }),
  ];
  const out = aggregateCounters(orders);
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 3);
  assert.equal(out[0].first_ordered_at, "2026-04-01T00:00:00.000Z");
  assert.equal(out[0].last_ordered_at, "2026-04-10T00:00:00.000Z");
});

test("aggregateCounters: different (drawing_id, product_id) tuples produce distinct rows", () => {
  const did_a = "a".repeat(64);
  const did_b = "b".repeat(64);
  const orders: Order[] = [
    makeOrder({ order_id: "o1", drawing_id: did_a, product_id: "tee" }),
    makeOrder({ order_id: "o2", drawing_id: did_a, product_id: "mug" }),
    makeOrder({ order_id: "o3", drawing_id: did_b, product_id: "tee" }),
    makeOrder({ order_id: "o4", drawing_id: did_a, product_id: "tee" }),
  ];
  const out = aggregateCounters(orders);
  assert.equal(out.length, 3);
  const byPk = new Map(out.map((c) => [c.pk, c]));
  assert.equal(byPk.get(counterPk(did_a, "tee"))!.count, 2);
  assert.equal(byPk.get(counterPk(did_a, "mug"))!.count, 1);
  assert.equal(byPk.get(counterPk(did_b, "tee"))!.count, 1);
});

test("backfillProductCounters: calls listOrders once per counted status (4) and aggregates the union", async () => {
  const calls: OrderStatus[] = [];
  const putBatches: ProductCounter[][] = [];

  const report = await backfillProductCounters({
    listOrders: async (status) => {
      calls.push(status);
      // One order per status to make the union easy to count.
      return [makeOrder({ status, order_id: `o_${status}`, created_at: `2026-04-0${calls.length}T00:00:00.000Z` })];
    },
    putCounters: async (batch) => {
      putBatches.push(batch);
    },
  });

  assert.deepEqual([...calls].sort(), [...COUNTED_STATUSES].sort());
  assert.equal(report.ordersScanned, 4);
  // All four are the same (drawing_id, product_id) → 1 counter row.
  assert.equal(report.countersWritten, 1);
  assert.equal(report.perCounter[0].count, 4);
  // Single batch flush since the counter count is well under 25.
  assert.equal(putBatches.length, 1);
  assert.equal(putBatches[0].length, 1);
});

test("backfillProductCounters: batches putCounters in chunks of 25", async () => {
  // Force 60 distinct counters so we exercise the 25/25/10 chunking.
  const orders: Order[] = [];
  for (let i = 0; i < 60; i++) {
    orders.push(makeOrder({
      order_id: `o${i}`,
      drawing_id: i.toString(16).padStart(64, "0"),
      product_id: "tee",
    }));
  }
  const putBatches: ProductCounter[][] = [];
  // Only one status returns the synthetic orders; the rest are empty.
  await backfillProductCounters({
    listOrders: async (status) => (status === "submitted" ? orders : []),
    putCounters: async (batch) => {
      putBatches.push(batch);
    },
  });
  assert.equal(putBatches.length, 3);
  assert.equal(putBatches[0].length, 25);
  assert.equal(putBatches[1].length, 25);
  assert.equal(putBatches[2].length, 10);
});

test("backfillProductCounters: zero orders → no putCounters call, empty report", async () => {
  const putBatches: ProductCounter[][] = [];
  const report = await backfillProductCounters({
    listOrders: async () => [],
    putCounters: async (b) => { putBatches.push(b); },
  });
  assert.equal(report.ordersScanned, 0);
  assert.equal(report.countersWritten, 0);
  assert.equal(putBatches.length, 0);
});

// -- Wire-up helper tests -------------------------------------------------

interface RecordedSend {
  cmd: QueryCommand | BatchWriteCommand;
}

function makeDoc(impl: (cmd: RecordedSend["cmd"]) => Promise<unknown>, calls: RecordedSend[] = []) {
  return {
    docClient: {
      send: ((cmd: RecordedSend["cmd"]) => {
        calls.push({ cmd });
        return impl(cmd);
      }) as unknown as DynamoDBDocumentClient["send"],
    },
    calls,
  };
}

test("makeListOrdersByStatus: paginates by ExclusiveStartKey and concatenates pages", async () => {
  const calls: RecordedSend[] = [];
  let invocation = 0;
  const { docClient } = makeDoc(async () => {
    invocation++;
    if (invocation === 1) {
      return { Items: [makeOrder({ order_id: "o1" })], LastEvaluatedKey: { order_id: "o1" } };
    }
    if (invocation === 2) {
      return { Items: [makeOrder({ order_id: "o2" })], LastEvaluatedKey: { order_id: "o2" } };
    }
    return { Items: [makeOrder({ order_id: "o3" })] };
  }, calls);

  const fn = makeListOrdersByStatus(docClient, "drawbang-orders");
  const out = await fn("submitted");
  assert.equal(out.length, 3);
  assert.equal(calls.length, 3);

  const first = calls[0].cmd as QueryCommand;
  assert.equal(first.input.IndexName, STATUS_GSI_NAME);
  assert.equal(first.input.ExclusiveStartKey, undefined);
  assert.equal(first.input.ExpressionAttributeValues![":status"], "submitted");

  const second = calls[1].cmd as QueryCommand;
  assert.deepEqual(second.input.ExclusiveStartKey, { order_id: "o1" });

  const third = calls[2].cmd as QueryCommand;
  assert.deepEqual(third.input.ExclusiveStartKey, { order_id: "o2" });
});

test("makePutCounters: BatchWrite with _g='all' stamped on every item for GSI visibility", async () => {
  const calls: RecordedSend[] = [];
  const { docClient } = makeDoc(async () => ({}), calls);
  const fn = makePutCounters(docClient, "drawbang-product-counters");

  const rows: ProductCounter[] = [
    { pk: "a#tee", drawing_id: "a", product_id: "tee", count: 5, first_ordered_at: "t1", last_ordered_at: "t2" },
    { pk: "b#mug", drawing_id: "b", product_id: "mug", count: 1, first_ordered_at: "t3", last_ordered_at: "t3" },
  ];

  await fn(rows);

  assert.equal(calls.length, 1);
  const cmd = calls[0].cmd as BatchWriteCommand;
  const reqItems = cmd.input.RequestItems!["drawbang-product-counters"];
  assert.equal(reqItems.length, 2);
  for (const r of reqItems) {
    assert.equal(r.PutRequest?.Item?._g, "all");
  }
});

test("makePutCounters: retries UnprocessedItems with exponential backoff and gives up after the limit", async () => {
  const calls: RecordedSend[] = [];
  const row: ProductCounter = {
    pk: "a#tee", drawing_id: "a", product_id: "tee",
    count: 1, first_ordered_at: "t", last_ordered_at: "t",
  };
  // Every call returns the same item as unprocessed.
  const { docClient } = makeDoc(async (cmd) => {
    const items = (cmd as BatchWriteCommand).input.RequestItems!["drawbang-product-counters"];
    return { UnprocessedItems: { "drawbang-product-counters": items } };
  }, calls);

  const fn = makePutCounters(docClient, "drawbang-product-counters");
  await assert.rejects(() => fn([row]), /still unprocessed/);
  // 5 attempts (the UNPROCESSED_RETRY_LIMIT).
  assert.equal(calls.length, 5);
});
