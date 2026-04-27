import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { OrdersStore, STATUS_GSI_NAME, type Order } from "../merch/orders.js";

interface RecordedSend {
  cmd: PutCommand | GetCommand | UpdateCommand | QueryCommand;
}

type SendImpl = (cmd: RecordedSend["cmd"]) => Promise<unknown>;

function fixtureOrder(overrides: Partial<Order> = {}): Order {
  return {
    order_id: "ord_1",
    drawing_id: "deadbeef".repeat(8),
    frame: 0,
    product_id: "tee",
    variant_id: 18395,
    retail_cents: 2400,
    base_cost_cents: 1199,
    status: "pending",
    created_at: "2026-04-27T10:00:00.000Z",
    updated_at: "2026-04-27T10:00:00.000Z",
    ...overrides,
  };
}

function makeStore(impl: SendImpl, calls: RecordedSend[] = []) {
  const docClient = {
    send: ((cmd: RecordedSend["cmd"]) => {
      calls.push({ cmd });
      return impl(cmd);
    }) as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient["send"],
  };
  const store = new OrdersStore({ tableName: "drawbang-orders", docClient });
  return { store, calls };
}

test("createOrder issues a PutItem with attribute_not_exists(order_id) condition", async () => {
  const calls: RecordedSend[] = [];
  const order = fixtureOrder();
  const { store } = makeStore(async () => ({}), calls);

  await store.createOrder(order);

  assert.equal(calls.length, 1);
  const cmd = calls[0].cmd;
  assert.ok(cmd instanceof PutCommand);
  assert.equal(cmd.input.TableName, "drawbang-orders");
  assert.equal(cmd.input.ConditionExpression, "attribute_not_exists(order_id)");
  assert.deepEqual(cmd.input.Item, order);
});

test("getOrder returns the unmarshalled item when present", async () => {
  const order = fixtureOrder();
  const { store, calls } = makeStore(async () => ({ Item: order }));

  const out = await store.getOrder("ord_1");
  assert.deepEqual(out, order);

  const cmd = calls[0].cmd;
  assert.ok(cmd instanceof GetCommand);
  assert.equal(cmd.input.TableName, "drawbang-orders");
  assert.deepEqual(cmd.input.Key, { order_id: "ord_1" });
});

test("getOrder returns null when no item is found", async () => {
  const { store } = makeStore(async () => ({})); // no Item
  const out = await store.getOrder("nope");
  assert.equal(out, null);
});

test("transition issues an UpdateItem with status condition + status alias and returns the new order", async () => {
  const updated = fixtureOrder({ status: "paid", stripe_session_id: "cs_test_1", updated_at: "later" });
  const { store, calls } = makeStore(async () => ({ Attributes: updated }));

  const out = await store.transition("ord_1", "pending", {
    status: "paid",
    stripe_session_id: "cs_test_1",
  });
  assert.deepEqual(out, updated);

  const cmd = calls[0].cmd;
  assert.ok(cmd instanceof UpdateCommand);
  assert.equal(cmd.input.TableName, "drawbang-orders");
  assert.deepEqual(cmd.input.Key, { order_id: "ord_1" });
  assert.equal(cmd.input.ConditionExpression, "#s = :expected");
  assert.equal(cmd.input.ReturnValues, "ALL_NEW");
  assert.equal(cmd.input.ExpressionAttributeNames!["#s"], "status");
  assert.equal(cmd.input.ExpressionAttributeValues![":expected"], "pending");
  // patch fields and updated_at must show up in the SET expression
  const expr = cmd.input.UpdateExpression!;
  assert.match(expr, /^SET /);
  // Each value placeholder used in SET must appear in ExpressionAttributeValues
  const valuePlaceholders = expr.match(/:v\d+/g) ?? [];
  for (const ph of valuePlaceholders) {
    assert.ok(ph in cmd.input.ExpressionAttributeValues!, `${ph} bound`);
  }
  // The patch values made it through
  const values = Object.values(cmd.input.ExpressionAttributeValues!);
  assert.ok(values.includes("paid"), "new status bound");
  assert.ok(values.includes("cs_test_1"), "stripe_session_id bound");
  // updated_at is auto-stamped to a fresh ISO timestamp
  assert.ok(
    values.some((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)),
    "auto updated_at stamp",
  );
});

test("transition returns null when the condition fails", async () => {
  const { store } = makeStore(async () => {
    const err = new Error("The conditional request failed");
    err.name = "ConditionalCheckFailedException";
    throw err;
  });

  const out = await store.transition("ord_1", "pending", { status: "paid" });
  assert.equal(out, null);
});

test("transition rethrows non-condition failures", async () => {
  const { store } = makeStore(async () => {
    const err = new Error("boom");
    err.name = "ServiceUnavailable";
    throw err;
  });

  await assert.rejects(
    () => store.transition("ord_1", "pending", { status: "paid" }),
    /boom/,
  );
});

test("listByStatus queries the status-created_at GSI and unwraps Items", async () => {
  const items = [fixtureOrder({ order_id: "a" }), fixtureOrder({ order_id: "b" })];
  const { store, calls } = makeStore(async () => ({ Items: items }));

  const out = await store.listByStatus("pending", 25);
  assert.deepEqual(out, items);

  const cmd = calls[0].cmd;
  assert.ok(cmd instanceof QueryCommand);
  assert.equal(cmd.input.IndexName, STATUS_GSI_NAME);
  assert.equal(cmd.input.KeyConditionExpression, "#s = :status");
  assert.equal(cmd.input.ExpressionAttributeNames!["#s"], "status");
  assert.equal(cmd.input.ExpressionAttributeValues![":status"], "pending");
  assert.equal(cmd.input.Limit, 25);
});

test("listByStatus omits Limit when not provided and returns [] when no Items field", async () => {
  const { store, calls } = makeStore(async () => ({}));
  const out = await store.listByStatus("paid");
  assert.deepEqual(out, []);
  assert.equal((calls[0].cmd as QueryCommand).input.Limit, undefined);
});
