import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
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

export interface Order {
  order_id: string;
  drawing_id: string;
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
      }),
    );
  }

  async getOrder(id: string): Promise<Order | null> {
    const out = await this.doc.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { order_id: id },
      }),
    );
    return (out.Item as Order | undefined) ?? null;
  }

  async transition(
    id: string,
    expectedStatus: OrderStatus,
    patch: Partial<Order>,
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
        }),
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
      }),
    );
    return (out.Items as Order[] | undefined) ?? [];
  }
}
