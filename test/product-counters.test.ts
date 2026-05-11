import { strict as assert } from "node:assert";
import { test } from "node:test";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  COUNT_GSI_NAME,
  ProductCountersStore,
  counterPk,
} from "../merch/product-counters.js";

interface RecordedSend {
  cmd: UpdateCommand | QueryCommand;
}

type SendImpl = (cmd: RecordedSend["cmd"]) => Promise<unknown>;

function makeStore(impl: SendImpl, calls: RecordedSend[] = []) {
  const docClient = {
    send: ((cmd: RecordedSend["cmd"]) => {
      calls.push({ cmd });
      return impl(cmd);
    }) as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient["send"],
  };
  const store = new ProductCountersStore({ tableName: "drawbang-product-counters", docClient });
  return { store, calls };
}

test("counterPk combines drawing_id and product_id with a '#' separator", () => {
  assert.equal(counterPk("d".repeat(64), "tee"), `${"d".repeat(64)}#tee`);
});

test("incrementOnSubmit issues an UpdateItem with ADD count, SET first/last/dim/pid/_g", async () => {
  const calls: RecordedSend[] = [];
  const { store } = makeStore(async () => ({}), calls);

  await store.incrementOnSubmit({
    drawing_id: "d".repeat(64),
    product_id: "tee",
    now: "2026-05-11T09:00:00.000Z",
  });

  assert.equal(calls.length, 1);
  const cmd = calls[0].cmd;
  assert.ok(cmd instanceof UpdateCommand);
  assert.equal(cmd.input.TableName, "drawbang-product-counters");
  assert.deepEqual(cmd.input.Key, { pk: `${"d".repeat(64)}#tee` });

  const expr = cmd.input.UpdateExpression!;
  assert.match(expr, /ADD #c :one/);
  assert.match(expr, /SET .*#last = :now/);
  // first_ordered_at is guarded by if_not_exists so it's only stamped on
  // the very first increment for a given (drawing, product) pair.
  assert.match(expr, /#first = if_not_exists\(#first, :now\)/);
  assert.match(expr, /#did = :drawing_id/);
  assert.match(expr, /#pid = :product_id/);
  assert.match(expr, /#g = :all/);

  const names = cmd.input.ExpressionAttributeNames!;
  assert.equal(names["#c"], "count");
  assert.equal(names["#last"], "last_ordered_at");
  assert.equal(names["#first"], "first_ordered_at");
  assert.equal(names["#did"], "drawing_id");
  assert.equal(names["#pid"], "product_id");
  assert.equal(names["#g"], "_g");

  const values = cmd.input.ExpressionAttributeValues!;
  assert.equal(values[":one"], 1);
  assert.equal(values[":now"], "2026-05-11T09:00:00.000Z");
  assert.equal(values[":drawing_id"], "d".repeat(64));
  assert.equal(values[":product_id"], "tee");
  assert.equal(values[":all"], "all");
});

test("listTop queries the all-count GSI with ScanIndexForward=false (count desc) and unwraps Items", async () => {
  const items = [
    { pk: "a#tee", drawing_id: "a", product_id: "tee", count: 7, first_ordered_at: "t", last_ordered_at: "t" },
    { pk: "b#mug", drawing_id: "b", product_id: "mug", count: 3, first_ordered_at: "t", last_ordered_at: "t" },
  ];
  const { store, calls } = makeStore(async () => ({ Items: items }));

  const out = await store.listTop({ limit: 36 });
  assert.deepEqual(out.items, items);
  assert.equal(out.lastEvaluatedKey, undefined);

  const cmd = calls[0].cmd;
  assert.ok(cmd instanceof QueryCommand);
  assert.equal(cmd.input.IndexName, COUNT_GSI_NAME);
  assert.equal(cmd.input.KeyConditionExpression, "#g = :all");
  assert.equal(cmd.input.ExpressionAttributeNames!["#g"], "_g");
  assert.equal(cmd.input.ExpressionAttributeValues![":all"], "all");
  assert.equal(cmd.input.ScanIndexForward, false);
  assert.equal(cmd.input.Limit, 36);
  assert.equal(cmd.input.ExclusiveStartKey, undefined);
});

test("listTop forwards ExclusiveStartKey for pagination and surfaces LastEvaluatedKey", async () => {
  const lek = { pk: "x#tee", _g: "all", count: 2 };
  const { store, calls } = makeStore(async () => ({ Items: [], LastEvaluatedKey: lek }));

  const out = await store.listTop({ limit: 5, exclusiveStartKey: { pk: "y#mug" } });
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.lastEvaluatedKey, lek);

  const cmd = calls[0].cmd as QueryCommand;
  assert.deepEqual(cmd.input.ExclusiveStartKey, { pk: "y#mug" });
});
