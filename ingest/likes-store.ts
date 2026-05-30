import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DrawingStore } from "./drawing-store.js";

// Likes on drawings. Backed by `drawbang-likes`: PK=drawing_id, SK=user_id,
// attr created_at_ms. GSI1-user inverts to (user_id, created_at_ms) for a
// future "drawings I liked" feed.
//
// Atomicity: like/unlike are TransactWriteItems across this table + the
// drawings table (ADD like_count :±1). A double-like or a missing drawing
// surfaces as a TransactionCanceledException; we walk CancellationReasons
// to turn each into the right typed error.

export interface LikeArgs {
  drawing_id: string;
  user_id: string;
  created_at_ms: number;
}

export interface UnlikeArgs {
  drawing_id: string;
  user_id: string;
}

export interface LikesStore {
  like(args: LikeArgs): Promise<void>;
  unlike(args: UnlikeArgs): Promise<void>;
  // Returns the subset of `drawing_ids` the user has liked. Order is not
  // guaranteed. Caller batches at the call site if it has >100 ids.
  listLikedDrawingIds(user_id: string, drawing_ids: string[]): Promise<string[]>;
}

export class AlreadyLikedError extends Error {
  constructor() {
    super("drawing already liked by user");
    this.name = "AlreadyLikedError";
  }
}

export class NotLikedError extends Error {
  constructor() {
    super("drawing not liked by user");
    this.name = "NotLikedError";
  }
}

export class DrawingNotFoundError extends Error {
  constructor() {
    super("drawing not found");
    this.name = "DrawingNotFoundError";
  }
}

// -- DynamoDB ----------------------------------------------------------------

export interface DynamoLikesStoreOptions {
  likesTable: string;
  drawingsTable: string;
  client?: DynamoDBDocumentClient;
}

export class DynamoLikesStore implements LikesStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly likesTable: string;
  private readonly drawingsTable: string;

  constructor(opts: DynamoLikesStoreOptions) {
    this.likesTable = opts.likesTable;
    this.drawingsTable = opts.drawingsTable;
    this.doc =
      opts.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async like(args: LikeArgs): Promise<void> {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.likesTable,
                Item: {
                  drawing_id: args.drawing_id,
                  user_id: args.user_id,
                  created_at_ms: args.created_at_ms,
                },
                ConditionExpression: "attribute_not_exists(drawing_id)",
              },
            },
            {
              Update: {
                TableName: this.drawingsTable,
                Key: { drawing_id: args.drawing_id },
                UpdateExpression: "ADD like_count :one",
                ConditionExpression: "attribute_exists(drawing_id)",
                ExpressionAttributeValues: { ":one": 1 },
              },
            },
          ],
        }),
      );
    } catch (e) {
      throw mapTransactError(e, "like");
    }
  }

  async unlike(args: UnlikeArgs): Promise<void> {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.likesTable,
                Key: {
                  drawing_id: args.drawing_id,
                  user_id: args.user_id,
                },
                ConditionExpression: "attribute_exists(drawing_id)",
              },
            },
            {
              Update: {
                TableName: this.drawingsTable,
                Key: { drawing_id: args.drawing_id },
                UpdateExpression: "ADD like_count :negone",
                ConditionExpression: "attribute_exists(drawing_id)",
                ExpressionAttributeValues: { ":negone": -1 },
              },
            },
          ],
        }),
      );
    } catch (e) {
      throw mapTransactError(e, "unlike");
    }
  }

  async listLikedDrawingIds(
    user_id: string,
    drawing_ids: string[],
  ): Promise<string[]> {
    if (drawing_ids.length === 0) return [];
    const r = await this.doc.send(
      new BatchGetCommand({
        RequestItems: {
          [this.likesTable]: {
            Keys: drawing_ids.map((drawing_id) => ({ drawing_id, user_id })),
            ProjectionExpression: "drawing_id",
          },
        },
      }),
    );
    const items = r.Responses?.[this.likesTable] ?? [];
    return items.map((it) => String(it.drawing_id));
  }
}

interface CancellationReason {
  Code?: string;
}

function mapTransactError(e: unknown, op: "like" | "unlike"): unknown {
  if (typeof e !== "object" || e === null) return e;
  const name = (e as { name?: unknown }).name;
  if (name !== "TransactionCanceledException") return e;
  const reasons = (e as { CancellationReasons?: CancellationReason[] })
    .CancellationReasons;
  if (!Array.isArray(reasons)) return e;
  // Item 0 = likes-table guard, item 1 = drawings-table existence.
  if (reasons[0]?.Code === "ConditionalCheckFailed") {
    return op === "like" ? new AlreadyLikedError() : new NotLikedError();
  }
  if (reasons[1]?.Code === "ConditionalCheckFailed") {
    return new DrawingNotFoundError();
  }
  return e;
}

// -- In-memory (tests + dev) --------------------------------------------------

// Pairs each user_id with the drawing rows they liked. Increments
// like_count on the shared MemoryDrawingStore so reads see the same value
// the prod handler would.
export class MemoryLikesStore implements LikesStore {
  private readonly byDrawing = new Map<string, Map<string, number>>();

  constructor(private readonly drawingStore: DrawingStore) {}

  async like(args: LikeArgs): Promise<void> {
    const row = await this.drawingStore.get(args.drawing_id);
    if (!row) throw new DrawingNotFoundError();
    const users = this.byDrawing.get(args.drawing_id) ?? new Map();
    if (users.has(args.user_id)) throw new AlreadyLikedError();
    users.set(args.user_id, args.created_at_ms);
    this.byDrawing.set(args.drawing_id, users);
    await this.drawingStore.put({
      ...row,
      like_count: (row.like_count ?? 0) + 1,
    });
  }

  async unlike(args: UnlikeArgs): Promise<void> {
    const row = await this.drawingStore.get(args.drawing_id);
    if (!row) throw new DrawingNotFoundError();
    const users = this.byDrawing.get(args.drawing_id);
    if (!users || !users.has(args.user_id)) throw new NotLikedError();
    users.delete(args.user_id);
    if (users.size === 0) this.byDrawing.delete(args.drawing_id);
    await this.drawingStore.put({
      ...row,
      like_count: Math.max(0, (row.like_count ?? 0) - 1),
    });
  }

  async listLikedDrawingIds(
    user_id: string,
    drawing_ids: string[],
  ): Promise<string[]> {
    const out: string[] = [];
    for (const id of drawing_ids) {
      if (this.byDrawing.get(id)?.has(user_id)) out.push(id);
    }
    return out;
  }
}
