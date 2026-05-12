import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Order, OrderStatus } from "../merch/orders.js";
import { STATUS_GSI_NAME } from "../merch/orders.js";
import { counterPk, type ProductCounter } from "../merch/product-counters.js";

// Statuses that count toward the popularity ranking. Matches the live
// writer's gate (paid -> submitted), so a backfilled corpus is consistent
// with what new orders will produce going forward. `paid` and `failed`
// are intentionally excluded.
export const COUNTED_STATUSES: readonly OrderStatus[] = [
  "submitted",
  "in_production",
  "shipped",
  "delivered",
];

const BATCH_WRITE_LIMIT = 25;
const UNPROCESSED_RETRY_LIMIT = 5;

export interface BackfillReport {
  ordersScanned: number;
  ordersIgnored: number;
  countersWritten: number;
  perCounter: Array<{
    drawing_id: string;
    product_id: string;
    count: number;
    first_ordered_at: string;
    last_ordered_at: string;
  }>;
}

export function aggregateCounters(orders: Order[]): ProductCounter[] {
  const acc = new Map<
    string,
    {
      drawing_id: string;
      product_id: string;
      count: number;
      first_ordered_at: string;
      last_ordered_at: string;
    }
  >();
  for (const o of orders) {
    const pk = counterPk(o.drawing_id, o.product_id);
    const prev = acc.get(pk);
    if (!prev) {
      acc.set(pk, {
        drawing_id: o.drawing_id,
        product_id: o.product_id,
        count: 1,
        first_ordered_at: o.created_at,
        last_ordered_at: o.created_at,
      });
    } else {
      prev.count++;
      if (o.created_at < prev.first_ordered_at) prev.first_ordered_at = o.created_at;
      if (o.created_at > prev.last_ordered_at) prev.last_ordered_at = o.created_at;
    }
  }
  return Array.from(acc.entries())
    .map(([pk, v]) => ({ pk, ...v }))
    .sort((a, b) => (a.pk < b.pk ? -1 : a.pk > b.pk ? 1 : 0));
}

export interface BackfillDeps {
  listOrders: (status: OrderStatus) => Promise<Order[]>;
  putCounters: (batch: ProductCounter[]) => Promise<void>;
  log?: (msg: string) => void;
  statuses?: readonly OrderStatus[];
}

export async function backfillProductCounters(deps: BackfillDeps): Promise<BackfillReport> {
  const log = deps.log ?? (() => {});
  const statuses = deps.statuses ?? COUNTED_STATUSES;

  const all: Order[] = [];
  for (const status of statuses) {
    const page = await deps.listOrders(status);
    log(`fetched ${page.length} order(s) at status=${status}`);
    all.push(...page);
  }

  const counters = aggregateCounters(all);
  log(`aggregated ${all.length} order(s) into ${counters.length} counter row(s)`);

  for (let i = 0; i < counters.length; i += BATCH_WRITE_LIMIT) {
    const chunk = counters.slice(i, i + BATCH_WRITE_LIMIT);
    await deps.putCounters(chunk);
  }

  return {
    ordersScanned: all.length,
    ordersIgnored: 0,
    countersWritten: counters.length,
    perCounter: counters.map((c) => ({
      drawing_id: c.drawing_id,
      product_id: c.product_id,
      count: c.count,
      first_ordered_at: c.first_ordered_at,
      last_ordered_at: c.last_ordered_at,
    })),
  };
}

// -- Production wire-up ------------------------------------------------------

export function makeListOrdersByStatus(
  doc: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
): (status: OrderStatus) => Promise<Order[]> {
  return async (status: OrderStatus): Promise<Order[]> => {
    const out: Order[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await doc.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: STATUS_GSI_NAME,
          KeyConditionExpression: "#s = :status",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":status": status },
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      out.push(...((res.Items as Order[] | undefined) ?? []));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return out;
  };
}

export function makePutCounters(
  doc: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
): (batch: ProductCounter[]) => Promise<void> {
  return async (batch: ProductCounter[]): Promise<void> => {
    if (batch.length === 0) return;
    let pending: ProductCounter[] = batch;
    for (let attempt = 0; attempt < UNPROCESSED_RETRY_LIMIT && pending.length > 0; attempt++) {
      const req = {
        [tableName]: pending.map((c) => ({
          PutRequest: { Item: { ...c, _g: "all" } },
        })),
      };
      const res = await doc.send(new BatchWriteCommand({ RequestItems: req }));
      const unprocessed = (res.UnprocessedItems ?? {})[tableName] ?? [];
      pending = unprocessed
        .map((u) => u.PutRequest?.Item as (ProductCounter & { _g?: string }) | undefined)
        .filter((x): x is ProductCounter & { _g?: string } => !!x)
        .map(({ _g: _g, ...rest }) => rest as ProductCounter);
      if (pending.length > 0) {
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
    }
    if (pending.length > 0) {
      throw new Error(`BatchWrite: ${pending.length} item(s) still unprocessed after ${UNPROCESSED_RETRY_LIMIT} retries`);
    }
  };
}

async function main(): Promise<void> {
  const ordersTable = process.env.DRAWBANG_ORDERS_TABLE ?? "drawbang-orders";
  const countersTable = process.env.DRAWBANG_PRODUCT_COUNTERS_TABLE ?? "drawbang-product-counters";
  const client = new DynamoDBClient({});
  const doc = DynamoDBDocumentClient.from(client);

  console.log(`orders table:   ${ordersTable}`);
  console.log(`counters table: ${countersTable}`);
  console.log(`statuses:       ${COUNTED_STATUSES.join(", ")}`);
  console.log("---");

  const report = await backfillProductCounters({
    listOrders: makeListOrdersByStatus(doc, ordersTable),
    putCounters: makePutCounters(doc, countersTable),
    log: (m) => console.log(m),
  });

  console.log("---");
  console.log(`orders scanned:   ${report.ordersScanned}`);
  console.log(`counters written: ${report.countersWritten}`);
  console.log("");
  if (report.perCounter.length === 0) {
    console.log("(no counters written — table is now empty)");
    return;
  }
  console.log("per-counter summary (drawing_id_short × product_id → count, first..last):");
  for (const c of report.perCounter) {
    console.log(
      `  ${c.drawing_id.slice(0, 8)} × ${c.product_id.padEnd(8)} ` +
        `→ count=${String(c.count).padStart(4)}  ` +
        `${c.first_ordered_at} .. ${c.last_ordered_at}`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
