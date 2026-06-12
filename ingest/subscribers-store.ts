import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

// Email-capture list for launch notes / digests. Backed by
// `drawbang-subscribers`: PK=email, attr created_at. Write-only from the
// app's point of view — sending lives elsewhere (deferred, see M10).

export interface SubscribersStore {
  // Idempotent: re-subscribing is a no-op that keeps the original
  // created_at, so the handler can always answer 200.
  subscribe(email: string, created_at: string): Promise<void>;
}

export interface DynamoSubscribersStoreOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
}

export class DynamoSubscribersStore implements SubscribersStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(opts: DynamoSubscribersStoreOptions) {
    this.tableName = opts.tableName;
    this.doc =
      opts.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async subscribe(email: string, created_at: string): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { email, created_at },
          ConditionExpression: "attribute_not_exists(email)",
        }),
      );
    } catch (e) {
      const name = (e as { name?: unknown }).name;
      if (name === "ConditionalCheckFailedException") return;
      throw e;
    }
  }
}

// -- In-memory (tests + dev) --------------------------------------------------

export class MemorySubscribersStore implements SubscribersStore {
  readonly emails = new Map<string, string>();

  async subscribe(email: string, created_at: string): Promise<void> {
    if (!this.emails.has(email)) this.emails.set(email, created_at);
  }
}
