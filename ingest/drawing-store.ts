import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

// Source of truth for published drawings in the dynamic-site world.
//
// Schema:
//   PK            drawing_id          # sha256(gif_bytes), hex
//   attrs:        size                # 8 | 16 | 32 | 64
//                 created_at          # ISO 8601 (display)
//                 created_at_ms       # number (sort key on GSIs)
//                 user_id             # 64-hex stable account id
//                 username            # denormalized for gallery render
//                 parent_id           # drawing_id of fork parent, or null
//                 prompt_id           # daily-prompt slug, or absent
//                 frames              # 1..16  (animated when > 1)
//                 gif_size_bytes
//
// GSIs:
//   GSI1 — gallery, chronological:  PK = "GALLERY"    SK = created_at_ms
//   GSI2 — per-profile gallery:     PK = username     SK = created_at_ms
//   GSI3 — forks of a parent:       PK = parent_id    SK = created_at_ms (sparse:
//          GSI3 only indexes rows that have a parent_id)
//   GSI4 — drawings for a prompt:   PK = prompt_id    SK = created_at_ms (sparse:
//          GSI4 only indexes rows that have a prompt_id)
//
// GSI2 is keyed on username (not user_id) because the /u/<username> URL is
// the public identity and usernames are immutable in v1 — saves a
// usernames-table lookup per profile pageload. If we ever support username
// changes, GSI2 needs to be rebuilt or backed by a user_id lookup.
//
// Queries always ScanIndexForward: false so newest-first. Pagination uses
// (created_at_ms, drawing_id) as a cursor encoded as URL-safe base64.

export interface DrawingRow {
  drawing_id: string;
  size: number;
  created_at: string;
  created_at_ms: number;
  user_id: string;
  username: string;
  parent_id: string | null;
  // Daily-prompt slug the drawing was published for. Optional (not null) so
  // untagged rows omit the attribute and GSI4 stays sparse.
  prompt_id?: string;
  frames: number;
  gif_size_bytes: number;
  // Denormalised likes counter. Maintained by LikesStore via TransactWrite
  // atop the like/unlike write. Absent on rows pre-dating the likes table.
  like_count?: number;
}

export interface DrawingCursor {
  created_at_ms: number;
  drawing_id: string;
}

export interface QueryPage {
  items: DrawingRow[];
  next_cursor: DrawingCursor | null;
}

export interface QueryOpts {
  limit: number;
  cursor?: DrawingCursor;
}

export interface DrawingStore {
  put(row: DrawingRow): Promise<void>;
  get(drawing_id: string): Promise<DrawingRow | null>;
  queryGallery(opts: QueryOpts): Promise<QueryPage>;
  queryByUsername(username: string, opts: QueryOpts): Promise<QueryPage>;
  queryForks(parent_id: string, opts: QueryOpts): Promise<QueryPage>;
  queryByPrompt(prompt_id: string, opts: QueryOpts): Promise<QueryPage>;
}

// Sentinel partition key for the gallery GSI. All drawings share it so the
// gallery is one chronological scan; at our traffic the hot-partition
// concern is theoretical. If it ever bites, swap to a date-bucket PK like
// `GALLERY#${yyyy-mm-dd}` and union the buckets at read time.
export const GALLERY_PARTITION = "GALLERY";

// -- Cursor codec -------------------------------------------------------------

function base64UrlEncode(s: string): string {
  // btoa is available in browsers; Node has it too since v16.
  const b = typeof Buffer !== "undefined" ? Buffer.from(s, "utf8").toString("base64") : btoa(s);
  return b.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return typeof Buffer !== "undefined"
    ? Buffer.from(padded, "base64").toString("utf8")
    : atob(padded);
}

export function encodeCursor(c: DrawingCursor): string {
  return base64UrlEncode(`${c.created_at_ms}:${c.drawing_id}`);
}

export function decodeCursor(s: string | null | undefined): DrawingCursor | null {
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

// -- DynamoDB ----------------------------------------------------------------

export interface DynamoDrawingStoreOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
}

export class DynamoDrawingStore implements DrawingStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(opts: DynamoDrawingStoreOptions) {
    this.table = opts.tableName;
    this.doc =
      opts.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async put(row: DrawingRow): Promise<void> {
    // PutItem is fine: drawing_id is content-addressed, so a re-publish of
    // the same bytes overwrites with identical attrs (idempotent). The
    // route handler already short-circuits on existing rows before calling
    // put(), so this PutItem path runs at most once per content id. We
    // stamp `gallery_pk = "GALLERY"` here so the row lands in GSI1; the
    // DrawingRow shape stays GSI-agnostic for the caller. parent_id is
    // omitted entirely when null (and prompt_id when unset) so GSI3/GSI4
    // stay sparse (DDB rejects NULL on a GSI key with ValidationException).
    const item: Record<string, unknown> = {
      ...row,
      gallery_pk: GALLERY_PARTITION,
    };
    if (row.parent_id === null) delete item.parent_id;
    if (row.prompt_id === undefined) delete item.prompt_id;
    await this.doc.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async get(drawing_id: string): Promise<DrawingRow | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { drawing_id } }),
    );
    return (r.Item as DrawingRow | undefined) ?? null;
  }

  async queryGallery(opts: QueryOpts): Promise<QueryPage> {
    return this.queryByPk("gallery_pk", GALLERY_PARTITION, "GSI1", opts);
  }

  async queryByUsername(username: string, opts: QueryOpts): Promise<QueryPage> {
    return this.queryByPk("username", username, "GSI2", opts);
  }

  async queryForks(parent_id: string, opts: QueryOpts): Promise<QueryPage> {
    return this.queryByPk("parent_id", parent_id, "GSI3", opts);
  }

  async queryByPrompt(prompt_id: string, opts: QueryOpts): Promise<QueryPage> {
    return this.queryByPk("prompt_id", prompt_id, "GSI4", opts);
  }

  private async queryByPk(
    pkName: string,
    pkValue: string,
    indexName: string,
    opts: QueryOpts,
  ): Promise<QueryPage> {
    const exclusiveStartKey = opts.cursor
      ? buildExclusiveStartKey(indexName, pkName, pkValue, opts.cursor)
      : undefined;
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: indexName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": pkName },
        ExpressionAttributeValues: { ":pk": pkValue },
        ScanIndexForward: false,
        Limit: opts.limit,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = (r.Items as DrawingRow[] | undefined) ?? [];
    const last = r.LastEvaluatedKey;
    const next_cursor: DrawingCursor | null = last
      ? {
          created_at_ms: Number(last.created_at_ms),
          drawing_id: String(last.drawing_id),
        }
      : null;
    return { items, next_cursor };
  }
}

function buildExclusiveStartKey(
  indexName: string,
  pkName: string,
  pkValue: string,
  cursor: DrawingCursor,
): Record<string, unknown> {
  // The base table is keyed on drawing_id alone, and each GSI is keyed on
  // its own (pk, created_at_ms). DDB's ExclusiveStartKey for a GSI query
  // needs both the GSI's pk+sk AND the base table's primary key.
  return {
    drawing_id: cursor.drawing_id,
    [pkName]: pkValue,
    created_at_ms: cursor.created_at_ms,
    ...(indexName === "GSI1" ? { gallery_pk: GALLERY_PARTITION } : {}),
  };
}

// -- In-memory (tests + dev) --------------------------------------------------

export class MemoryDrawingStore implements DrawingStore {
  private readonly byId = new Map<string, DrawingRow>();

  async put(row: DrawingRow): Promise<void> {
    this.byId.set(row.drawing_id, { ...row });
  }

  async get(drawing_id: string): Promise<DrawingRow | null> {
    const row = this.byId.get(drawing_id);
    return row ? { ...row } : null;
  }

  async queryGallery(opts: QueryOpts): Promise<QueryPage> {
    return this.pageByFilter(() => true, opts);
  }

  async queryByUsername(username: string, opts: QueryOpts): Promise<QueryPage> {
    return this.pageByFilter((r) => r.username === username, opts);
  }

  async queryForks(parent_id: string, opts: QueryOpts): Promise<QueryPage> {
    return this.pageByFilter((r) => r.parent_id === parent_id, opts);
  }

  async queryByPrompt(prompt_id: string, opts: QueryOpts): Promise<QueryPage> {
    return this.pageByFilter((r) => r.prompt_id === prompt_id, opts);
  }

  private pageByFilter(
    pred: (r: DrawingRow) => boolean,
    opts: QueryOpts,
  ): QueryPage {
    // newest-first; ties broken by drawing_id desc for determinism (matches
    // the DDB ordering when ScanIndexForward=false and SKs collide).
    const sorted = [...this.byId.values()]
      .filter(pred)
      .sort((a, b) => {
        if (b.created_at_ms !== a.created_at_ms) {
          return b.created_at_ms - a.created_at_ms;
        }
        return b.drawing_id.localeCompare(a.drawing_id);
      });
    let start = 0;
    if (opts.cursor) {
      const c = opts.cursor;
      start = sorted.findIndex(
        (r) =>
          r.created_at_ms < c.created_at_ms ||
          (r.created_at_ms === c.created_at_ms && r.drawing_id < c.drawing_id),
      );
      if (start < 0) start = sorted.length;
    }
    const items = sorted.slice(start, start + opts.limit);
    const next_cursor: DrawingCursor | null =
      start + opts.limit < sorted.length
        ? {
            created_at_ms: items[items.length - 1].created_at_ms,
            drawing_id: items[items.length - 1].drawing_id,
          }
        : null;
    return { items: items.map((r) => ({ ...r })), next_cursor };
  }
}
