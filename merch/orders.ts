import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Placement } from "./placement.js";
import type { ShippingAddress } from "./printify.js";

export type OrderStatus =
  | "pending"
  | "paid"
  | "submitted"
  | "in_production"
  | "shipped"
  | "delivered"
  | "failed"
  | "refunded";

export type OrderEnv = "prod" | "sandbox";

export interface Order {
  order_id: string;
  // Runtime env the order was created in — sandbox orders use Stripe test
  // keys and never hit Printify. Used to exclude them from product
  // popularity counters and KPIs. Old rows may lack the field; treat
  // missing as "prod" for backwards compat.
  env?: OrderEnv;
  // The 64-hex content id of the print source. For a single tile this is the
  // tile_id; for a multi-tile canvas it equals canvas_id (set below) so the
  // existing code paths keyed on drawing_id keep working.
  drawing_id: string;
  // Present only for canvas orders — signals dispatch to rebuild the square
  // composite from the canvas manifest instead of decoding a single tile gif.
  canvas_id?: string;
  frame: number;
  product_id: string;
  variant_id: number;
  // Optional — orders predating #147 carry no placement and dispatch
  // defaults to "full-chest", preserving the pre-feature behaviour.
  placement?: Placement;
  retail_cents: number;
  base_cost_cents: number;
  stripe_session_id?: string;
  printify_product_id?: string;
  printify_order_id?: string;
  status: OrderStatus;
  customer_email?: string;
  shipping_address?: ShippingAddress;
  created_at: string;
  updated_at: string;
}

export interface OrdersStoreConfig {
  tableName: string;
  client?: DynamoDBClient;
  // Test seam: skip the DynamoDBDocumentClient.from() wrap and use the
  // supplied client directly. The DocumentClient shares the underlying
  // client's middleware stack rather than calling client.send, so stubbing
  // client.send doesn't intercept anything; tests inject docClient instead.
  docClient?: Pick<DynamoDBDocumentClient, "send">;
}

export const STATUS_GSI_NAME = "status-created_at-index";
const IMMUTABLE_FIELDS: ReadonlySet<string> = new Set(["order_id", "created_at"]);

export class OrdersStore {
  private readonly doc: Pick<DynamoDBDocumentClient, "send">;
  private readonly tableName: string;

  constructor(cfg: OrdersStoreConfig) {
    if (cfg.docClient) {
      this.doc = cfg.docClient;
    } else {
      const client = cfg.client ?? new DynamoDBClient({});
      this.doc = DynamoDBDocumentClient.from(client);
    }
    this.tableName = cfg.tableName;
  }

  async createOrder(o: Order): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: o,
        ConditionExpression: "attribute_not_exists(order_id)",
      })
    );
  }

  async getOrder(id: string): Promise<Order | null> {
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { order_id: id },
      })
    );
    return (out.Item as Order | undefined) ?? null;
  }

  async transition(
    id: string,
    expectedStatus: OrderStatus,
    patch: Partial<Order>
  ): Promise<Order | null> {
    const setClauses: string[] = [];
    const names: Record<string, string> = { "#s": "status" };
    const values: Record<string, unknown> = { ":expected": expectedStatus };

    let i = 0;
    const usedKeys = new Set<string>();
    for (const [key, val] of Object.entries(patch)) {
      if (IMMUTABLE_FIELDS.has(key)) continue;
      if (val === undefined) continue;
      const nameKey = `#k${i}`;
      const valueKey = `:v${i}`;
      names[nameKey] = key;
      values[valueKey] = val;
      setClauses.push(`${nameKey} = ${valueKey}`);
      usedKeys.add(key);
      i++;
    }

    if (!usedKeys.has("updated_at")) {
      const nameKey = `#k${i}`;
      const valueKey = `:v${i}`;
      names[nameKey] = "updated_at";
      values[valueKey] = new Date().toISOString();
      setClauses.push(`${nameKey} = ${valueKey}`);
    }

    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { order_id: id },
          UpdateExpression: `SET ${setClauses.join(", ")}`,
          ConditionExpression: "#s = :expected",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        })
      );
      return (out.Attributes as Order | undefined) ?? null;
    } catch (err) {
      if (err instanceof Error && err.name === "ConditionalCheckFailedException") return null;
      throw err;
    }
  }

  async listByStatus(status: OrderStatus, limit?: number): Promise<Order[]> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: STATUS_GSI_NAME,
        KeyConditionExpression: "#s = :status",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":status": status },
        ...(limit !== undefined ? { Limit: limit } : {}),
      })
    );
    return (out.Items as Order[] | undefined) ?? [];
  }

  async scanRecent(limit = 100): Promise<Order[]> {
    const out = await this.doc.send(
      new ScanCommand({
        TableName: this.tableName,
        Limit: limit,
      })
    );
    const items = (out.Items as Order[] | undefined) ?? [];
    // Sort newest first by created_at; fall back to updated_at.
    items.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return items.slice(0, limit);
  }

  async adminSetStatus(id: string, status: OrderStatus): Promise<Order | null> {
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { order_id: id },
          UpdateExpression: "SET #s = :status, #u = :now",
          ExpressionAttributeNames: { "#s": "status", "#u": "updated_at" },
          ExpressionAttributeValues: { ":status": status, ":now": new Date().toISOString() },
          ReturnValues: "ALL_NEW",
        })
      );
      return (out.Attributes as Order | undefined) ?? null;
    } catch (err) {
      if (err instanceof Error && err.name === "ConditionalCheckFailedException") return null;
      throw err;
    }
  }

  async adminSetEnv(id: string, env: OrderEnv): Promise<Order | null> {
    try {
      const out = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { order_id: id },
          UpdateExpression: "SET #e = :env, #u = :now",
          ExpressionAttributeNames: { "#e": "env", "#u": "updated_at" },
          ExpressionAttributeValues: { ":env": env, ":now": new Date().toISOString() },
          ReturnValues: "ALL_NEW",
        })
      );
      return (out.Attributes as Order | undefined) ?? null;
    } catch (err) {
      if (err instanceof Error && err.name === "ConditionalCheckFailedException") return null;
      throw err;
    }
  }
}

export class MemoryOrdersStore {
  private readonly store = new Map<string, Order>();

  async createOrder(o: Order): Promise<void> {
    if (this.store.has(o.order_id)) throw new Error("ConditionalCheckFailedException");
    this.store.set(o.order_id, { ...o });
  }

  async getOrder(id: string): Promise<Order | null> {
    const v = this.store.get(id);
    return v ? { ...v } : null;
  }

  async transition(
    id: string,
    expectedStatus: OrderStatus,
    patch: Partial<Order>
  ): Promise<Order | null> {
    const cur = this.store.get(id);
    if (!cur || cur.status !== expectedStatus) return null;
    const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
    this.store.set(id, next);
    return { ...next };
  }

  async listByStatus(status: OrderStatus, limit?: number): Promise<Order[]> {
    const out = [...this.store.values()].filter((o) => o.status === status);
    return limit !== undefined ? out.slice(0, limit) : out;
  }

  async scanRecent(limit = 100): Promise<Order[]> {
    const out = [...this.store.values()];
    out.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return out.slice(0, limit);
  }

  async adminSetStatus(id: string, status: OrderStatus): Promise<Order | null> {
    const cur = this.store.get(id);
    if (!cur) return null;
    const next = { ...cur, status, updated_at: new Date().toISOString() };
    this.store.set(id, next);
    return { ...next };
  }

  async adminSetEnv(id: string, env: OrderEnv): Promise<Order | null> {
    const cur = this.store.get(id);
    if (!cur) return null;
    const next = { ...cur, env, updated_at: new Date().toISOString() };
    this.store.set(id, next);
    return { ...next };
  }
}
