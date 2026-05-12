import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

export interface ProductCounter {
  pk: string;
  drawing_id: string;
  product_id: string;
  count: number;
  first_ordered_at: string;
  last_ordered_at: string;
}

export interface ProductCountersStoreConfig {
  tableName: string;
  client?: DynamoDBClient;
  // Test seam: same pattern as OrdersStore — inject a docClient because
  // DynamoDBDocumentClient.from() shares the underlying client's middleware
  // stack rather than calling client.send.
  docClient?: Pick<DynamoDBDocumentClient, "send">;
}

export const COUNT_GSI_NAME = "all-count-index";
const GSI_PARTITION = "all";

export function counterPk(drawingId: string, productId: string): string {
  return `${drawingId}#${productId}`;
}

export class ProductCountersStore {
  private readonly doc: Pick<DynamoDBDocumentClient, "send">;
  private readonly tableName: string;

  constructor(cfg: ProductCountersStoreConfig) {
    if (cfg.docClient) {
      this.doc = cfg.docClient;
    } else {
      const client = cfg.client ?? new DynamoDBClient({});
      this.doc = DynamoDBDocumentClient.from(client);
    }
    this.tableName = cfg.tableName;
  }

  // Atomic +1 with first/last timestamps. Caller gates this on the
  // paid → submitted transition succeeding so the counter records exactly
  // one increment per order, even on dispatch retries.
  async incrementOnSubmit(args: {
    drawing_id: string;
    product_id: string;
    now: string;
  }): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: counterPk(args.drawing_id, args.product_id) },
        UpdateExpression:
          "ADD #c :one " +
          "SET #last = :now, " +
          "#first = if_not_exists(#first, :now), " +
          "#did = :drawing_id, " +
          "#pid = :product_id, " +
          "#g = :all",
        ExpressionAttributeNames: {
          "#c": "count",
          "#last": "last_ordered_at",
          "#first": "first_ordered_at",
          "#did": "drawing_id",
          "#pid": "product_id",
          "#g": "_g",
        },
        ExpressionAttributeValues: {
          ":one": 1,
          ":now": args.now,
          ":drawing_id": args.drawing_id,
          ":product_id": args.product_id,
          ":all": GSI_PARTITION,
        },
      }),
    );
  }

  async listTop(args: {
    limit: number;
    exclusiveStartKey?: Record<string, unknown>;
  }): Promise<{ items: ProductCounter[]; lastEvaluatedKey?: Record<string, unknown> }> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: COUNT_GSI_NAME,
        KeyConditionExpression: "#g = :all",
        ExpressionAttributeNames: { "#g": "_g" },
        ExpressionAttributeValues: { ":all": GSI_PARTITION },
        ScanIndexForward: false,
        Limit: args.limit,
        ...(args.exclusiveStartKey ? { ExclusiveStartKey: args.exclusiveStartKey } : {}),
      }),
    );
    return {
      items: (out.Items as ProductCounter[] | undefined) ?? [],
      ...(out.LastEvaluatedKey ? { lastEvaluatedKey: out.LastEvaluatedKey } : {}),
    };
  }

  // Drain the GSI in count-desc order. Page size is the DynamoDB Query
  // per-call ceiling (1MB); the builder paginates the final card list
  // itself at PER_PAGE.
  async listAll(): Promise<ProductCounter[]> {
    const out: ProductCounter[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const page = await this.listTop({ limit: 1000, exclusiveStartKey: lastKey });
      out.push(...page.items);
      lastKey = page.lastEvaluatedKey;
    } while (lastKey);
    return out;
  }
}
