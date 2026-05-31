import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DrawingRow, DrawingStore } from "./drawing-store.js";

// Bookmarks: a per-user list of saved drawings. Backed by
// `drawbang-bookmarks`: PK=user_id (the saver), SK=created_at_ms.
// drawing_id lives as an attribute so the same drawing can be saved at
// different times (only the latest write wins — see `bookmark` below).
//
// No counter denormalisation: bookmark counts aren't public in v1, so
// we don't need a TransactWrite against DrawingsTable like LikesStore
// does. That keeps the write path a single PutItem.
//
// Pagination is newest-first on created_at_ms. The store enforces
// drawing existence on bookmark() so users can't save a 404.

export interface BookmarkArgs {
  drawing_id: string;
  user_id: string;
  created_at_ms: number;
}

export interface UnbookmarkArgs {
  drawing_id: string;
  user_id: string;
}

export interface BookmarkRow {
  drawing_id: string;
  user_id: string;
  created_at_ms: number;
}

export interface BookmarksCursor {
  created_at_ms: number;
  drawing_id: string;
}

export interface BookmarksPage {
  items: BookmarkRow[];
  next_cursor: BookmarksCursor | null;
}

export interface BookmarksQueryOpts {
  limit: number;
  cursor?: BookmarksCursor;
}

export interface BookmarksStore {
  bookmark(args: BookmarkArgs): Promise<void>;
  unbookmark(args: UnbookmarkArgs): Promise<void>;
  // Returns the subset of `drawing_ids` the user has bookmarked. Order is
  // not guaranteed.
  listBookmarkedDrawingIds(
    user_id: string,
    drawing_ids: string[],
  ): Promise<string[]>;
  // Per-user bookmark feed, newest-first.
  listByUser(user_id: string, opts: BookmarksQueryOpts): Promise<BookmarksPage>;
}

export class AlreadyBookmarkedError extends Error {
  constructor() {
    super("drawing already bookmarked by user");
    this.name = "AlreadyBookmarkedError";
  }
}

export class NotBookmarkedError extends Error {
  constructor() {
    super("drawing not bookmarked by user");
    this.name = "NotBookmarkedError";
  }
}

export class BookmarkDrawingNotFoundError extends Error {
  constructor() {
    super("drawing not found");
    this.name = "BookmarkDrawingNotFoundError";
  }
}

// -- DynamoDB ----------------------------------------------------------------

export interface DynamoBookmarksStoreOptions {
  bookmarksTable: string;
  drawingStore: DrawingStore;
  client?: DynamoDBDocumentClient;
}

// On-disk layout in `drawbang-bookmarks`:
//   PK   user_id
//   SK   drawing_id          # one row per (user, drawing) pair
//   attr created_at_ms       # when the bookmark was saved
//
// We pick drawing_id as the SK (rather than created_at_ms) so the
// "already bookmarked?" guard is a cheap conditional Put on a known
// composite key. The newest-first listing uses a GSI keyed on
// (user_id, created_at_ms) — see template.yaml.
export class DynamoBookmarksStore implements BookmarksStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;
  private readonly drawingStore: DrawingStore;

  constructor(opts: DynamoBookmarksStoreOptions) {
    this.table = opts.bookmarksTable;
    this.drawingStore = opts.drawingStore;
    this.doc =
      opts.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async bookmark(args: BookmarkArgs): Promise<void> {
    // Drawing existence check is a separate GetItem on DrawingsTable
    // rather than a TransactWrite — bookmark counts aren't
    // denormalised, so there's no second table to atomically touch.
    // The race window (drawing deleted between GetItem and Put) is
    // acceptable; bookmarks on a now-missing drawing simply render as
    // dead tiles on /u/<username>/bookmarks.
    const row = await this.drawingStore.get(args.drawing_id);
    if (!row) throw new BookmarkDrawingNotFoundError();
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            user_id: args.user_id,
            drawing_id: args.drawing_id,
            created_at_ms: args.created_at_ms,
          },
          ConditionExpression: "attribute_not_exists(user_id)",
        }),
      );
    } catch (e) {
      if (isConditionalCheckFailed(e)) throw new AlreadyBookmarkedError();
      throw e;
    }
  }

  async unbookmark(args: UnbookmarkArgs): Promise<void> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { user_id: args.user_id, drawing_id: args.drawing_id },
          ConditionExpression: "attribute_exists(user_id)",
        }),
      );
    } catch (e) {
      if (isConditionalCheckFailed(e)) throw new NotBookmarkedError();
      throw e;
    }
  }

  async listBookmarkedDrawingIds(
    user_id: string,
    drawing_ids: string[],
  ): Promise<string[]> {
    if (drawing_ids.length === 0) return [];
    const r = await this.doc.send(
      new BatchGetCommand({
        RequestItems: {
          [this.table]: {
            Keys: drawing_ids.map((drawing_id) => ({ user_id, drawing_id })),
            ProjectionExpression: "drawing_id",
          },
        },
      }),
    );
    const items = r.Responses?.[this.table] ?? [];
    return items.map((it) => String(it.drawing_id));
  }

  async listByUser(
    user_id: string,
    opts: BookmarksQueryOpts,
  ): Promise<BookmarksPage> {
    const exclusiveStartKey = opts.cursor
      ? {
          user_id,
          drawing_id: opts.cursor.drawing_id,
          created_at_ms: opts.cursor.created_at_ms,
        }
      : undefined;
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "GSI1-recent",
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "user_id" },
        ExpressionAttributeValues: { ":pk": user_id },
        ScanIndexForward: false,
        Limit: opts.limit,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = ((r.Items as BookmarkRow[] | undefined) ?? []).map((it) => ({
      drawing_id: String(it.drawing_id),
      user_id: String(it.user_id),
      created_at_ms: Number(it.created_at_ms),
    }));
    const last = r.LastEvaluatedKey;
    const next_cursor: BookmarksCursor | null = last
      ? {
          created_at_ms: Number(last.created_at_ms),
          drawing_id: String(last.drawing_id),
        }
      : null;
    return { items, next_cursor };
  }
}

function isConditionalCheckFailed(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  return (e as { name?: unknown }).name === "ConditionalCheckFailedException";
}

// -- Cursor codec -------------------------------------------------------------

function base64UrlEncode(s: string): string {
  const b =
    typeof Buffer !== "undefined"
      ? Buffer.from(s, "utf8").toString("base64")
      : btoa(s);
  return b.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(s: string): string {
  const padded =
    s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return typeof Buffer !== "undefined"
    ? Buffer.from(padded, "base64").toString("utf8")
    : atob(padded);
}

export function encodeBookmarksCursor(c: BookmarksCursor): string {
  return base64UrlEncode(`${c.created_at_ms}:${c.drawing_id}`);
}

export function decodeBookmarksCursor(
  s: string | null | undefined,
): BookmarksCursor | null {
  if (!s) return null;
  let raw: string;
  try {
    raw = base64UrlDecode(s);
  } catch {
    return null;
  }
  const colon = raw.indexOf(":");
  if (colon < 0) return null;
  const ms = Number.parseInt(raw.slice(0, colon), 10);
  const id = raw.slice(colon + 1);
  if (!Number.isFinite(ms) || !/^[0-9a-f]{64}$/.test(id)) return null;
  return { created_at_ms: ms, drawing_id: id };
}

// -- In-memory (tests + dev) --------------------------------------------------

// Pairs each user_id with their bookmark rows. Stores both directions in
// memory: byUser for the per-user feed, plus a (user_id, drawing_id) →
// row map for the membership queries that listBookmarkedDrawingIds runs.
export class MemoryBookmarksStore implements BookmarksStore {
  private readonly byUser = new Map<string, Map<string, BookmarkRow>>();

  constructor(private readonly drawingStore: DrawingStore) {}

  async bookmark(args: BookmarkArgs): Promise<void> {
    const row: DrawingRow | null = await this.drawingStore.get(args.drawing_id);
    if (!row) throw new BookmarkDrawingNotFoundError();
    const users = this.byUser.get(args.user_id) ?? new Map<string, BookmarkRow>();
    if (users.has(args.drawing_id)) throw new AlreadyBookmarkedError();
    users.set(args.drawing_id, {
      user_id: args.user_id,
      drawing_id: args.drawing_id,
      created_at_ms: args.created_at_ms,
    });
    this.byUser.set(args.user_id, users);
  }

  async unbookmark(args: UnbookmarkArgs): Promise<void> {
    const users = this.byUser.get(args.user_id);
    if (!users || !users.has(args.drawing_id)) {
      throw new NotBookmarkedError();
    }
    users.delete(args.drawing_id);
    if (users.size === 0) this.byUser.delete(args.user_id);
  }

  async listBookmarkedDrawingIds(
    user_id: string,
    drawing_ids: string[],
  ): Promise<string[]> {
    const users = this.byUser.get(user_id);
    if (!users) return [];
    const out: string[] = [];
    for (const id of drawing_ids) {
      if (users.has(id)) out.push(id);
    }
    return out;
  }

  async listByUser(
    user_id: string,
    opts: BookmarksQueryOpts,
  ): Promise<BookmarksPage> {
    const all = [...(this.byUser.get(user_id)?.values() ?? [])].sort((a, b) => {
      if (b.created_at_ms !== a.created_at_ms) {
        return b.created_at_ms - a.created_at_ms;
      }
      return b.drawing_id.localeCompare(a.drawing_id);
    });
    let start = 0;
    if (opts.cursor) {
      const c = opts.cursor;
      start = all.findIndex(
        (r) =>
          r.created_at_ms < c.created_at_ms ||
          (r.created_at_ms === c.created_at_ms && r.drawing_id < c.drawing_id),
      );
      if (start < 0) start = all.length;
    }
    const items = all.slice(start, start + opts.limit);
    const next_cursor: BookmarksCursor | null =
      start + opts.limit < all.length
        ? {
            created_at_ms: items[items.length - 1].created_at_ms,
            drawing_id: items[items.length - 1].drawing_id,
          }
        : null;
    return { items, next_cursor };
  }
}
