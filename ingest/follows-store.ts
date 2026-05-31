import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { MemoryUserStore } from "./user-store.js";

// Follow edges between accounts. Backed by `drawbang-follows`:
//   PK   follower_user_id     # who I follow
//   SK   followee_user_id
//   attr created_at_ms
//
// GSI1-follower keys on (follower_user_id, created_at_ms) for the
// `/following` listing (newest-first). GSI2-followee keys on
// (followee_user_id, created_at_ms) for the `/followers` listing.
//
// follow()/unfollow() are TransactWriteItems across this table + the
// users table (drawbang-users, PK=email), bumping follower_count on the
// followee row and following_count on the follower row. That keeps the
// denormalised counts truthful even under concurrent writes; a
// double-follow surfaces as a TransactionCanceledException which we map
// to AlreadyFollowingError.

export interface FollowParty {
  user_id: string;
  username: string;
  email: string;
}

export interface FollowArgs {
  follower: FollowParty;
  followee: FollowParty;
  created_at_ms: number;
}

export interface UnfollowArgs {
  follower: FollowParty;
  followee: FollowParty;
}

// Usernames are denormalised onto each row at write time so the
// /followers + /following list endpoints can render without a second
// table hop. Safe because usernames are immutable in v1 (see CLAUDE.md
// "Identity model").
export interface FollowEdge {
  follower_user_id: string;
  follower_username: string;
  followee_user_id: string;
  followee_username: string;
  created_at_ms: number;
}

export interface FollowCursor {
  created_at_ms: number;
  // The other-side user_id — uniquely identifies a row when timestamps
  // collide. For follower listings this is the follower_user_id; for
  // following listings, the followee_user_id.
  other_user_id: string;
}

export interface FollowsPage {
  items: FollowEdge[];
  next_cursor: FollowCursor | null;
}

export interface FollowsQueryOpts {
  limit: number;
  cursor?: FollowCursor;
}

export interface FollowsStore {
  follow(args: FollowArgs): Promise<void>;
  unfollow(args: UnfollowArgs): Promise<void>;
  // Returns the subset of `target_user_ids` the viewer currently follows.
  // Order is not guaranteed.
  listFollowed(
    follower_user_id: string,
    target_user_ids: string[],
  ): Promise<string[]>;
  // Newest-first edges where `user_id` is the followee (people who follow them).
  listFollowers(user_id: string, opts: FollowsQueryOpts): Promise<FollowsPage>;
  // Newest-first edges where `user_id` is the follower (people they follow).
  listFollowing(user_id: string, opts: FollowsQueryOpts): Promise<FollowsPage>;
}

export class AlreadyFollowingError extends Error {
  constructor() {
    super("already following");
    this.name = "AlreadyFollowingError";
  }
}

export class NotFollowingError extends Error {
  constructor() {
    super("not following");
    this.name = "NotFollowingError";
  }
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

export function encodeFollowCursor(c: FollowCursor): string {
  return base64UrlEncode(`${c.created_at_ms}:${c.other_user_id}`);
}

export function decodeFollowCursor(
  s: string | null | undefined,
): FollowCursor | null {
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
  return { created_at_ms: ms, other_user_id: id };
}

// -- DynamoDB ----------------------------------------------------------------

export interface DynamoFollowsStoreOptions {
  followsTable: string;
  usersTable: string;
  client?: DynamoDBDocumentClient;
}

export class DynamoFollowsStore implements FollowsStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly followsTable: string;
  private readonly usersTable: string;

  constructor(opts: DynamoFollowsStoreOptions) {
    this.followsTable = opts.followsTable;
    this.usersTable = opts.usersTable;
    this.doc =
      opts.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async follow(args: FollowArgs): Promise<void> {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.followsTable,
                Item: {
                  follower_user_id: args.follower.user_id,
                  follower_username: args.follower.username,
                  followee_user_id: args.followee.user_id,
                  followee_username: args.followee.username,
                  created_at_ms: args.created_at_ms,
                },
                ConditionExpression: "attribute_not_exists(follower_user_id)",
              },
            },
            {
              Update: {
                TableName: this.usersTable,
                Key: { email: args.follower.email },
                UpdateExpression: "ADD following_count :one",
                ConditionExpression: "attribute_exists(email)",
                ExpressionAttributeValues: { ":one": 1 },
              },
            },
            {
              Update: {
                TableName: this.usersTable,
                Key: { email: args.followee.email },
                UpdateExpression: "ADD follower_count :one",
                ConditionExpression: "attribute_exists(email)",
                ExpressionAttributeValues: { ":one": 1 },
              },
            },
          ],
        }),
      );
    } catch (e) {
      throw mapTransactError(e, "follow");
    }
  }

  async unfollow(args: UnfollowArgs): Promise<void> {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.followsTable,
                Key: {
                  follower_user_id: args.follower.user_id,
                  followee_user_id: args.followee.user_id,
                },
                ConditionExpression: "attribute_exists(follower_user_id)",
              },
            },
            {
              Update: {
                TableName: this.usersTable,
                Key: { email: args.follower.email },
                UpdateExpression: "ADD following_count :neg",
                ConditionExpression: "attribute_exists(email)",
                ExpressionAttributeValues: { ":neg": -1 },
              },
            },
            {
              Update: {
                TableName: this.usersTable,
                Key: { email: args.followee.email },
                UpdateExpression: "ADD follower_count :neg",
                ConditionExpression: "attribute_exists(email)",
                ExpressionAttributeValues: { ":neg": -1 },
              },
            },
          ],
        }),
      );
    } catch (e) {
      throw mapTransactError(e, "unfollow");
    }
  }

  async listFollowed(
    follower_user_id: string,
    target_user_ids: string[],
  ): Promise<string[]> {
    if (target_user_ids.length === 0) return [];
    const r = await this.doc.send(
      new BatchGetCommand({
        RequestItems: {
          [this.followsTable]: {
            Keys: target_user_ids.map((followee_user_id) => ({
              follower_user_id,
              followee_user_id,
            })),
            ProjectionExpression: "followee_user_id",
          },
        },
      }),
    );
    const items = r.Responses?.[this.followsTable] ?? [];
    return items.map((it) => String(it.followee_user_id));
  }

  async listFollowers(
    user_id: string,
    opts: FollowsQueryOpts,
  ): Promise<FollowsPage> {
    // GSI2-followee — newest-first edges keyed on the followee.
    const exclusiveStartKey = opts.cursor
      ? {
          followee_user_id: user_id,
          follower_user_id: opts.cursor.other_user_id,
          created_at_ms: opts.cursor.created_at_ms,
        }
      : undefined;
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.followsTable,
        IndexName: "GSI2-followee",
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "followee_user_id" },
        ExpressionAttributeValues: { ":pk": user_id },
        ScanIndexForward: false,
        Limit: opts.limit,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items: FollowEdge[] = ((r.Items as FollowEdge[] | undefined) ?? []).map(
      (it) => ({
        follower_user_id: String(it.follower_user_id),
        follower_username: String(it.follower_username),
        followee_user_id: String(it.followee_user_id),
        followee_username: String(it.followee_username),
        created_at_ms: Number(it.created_at_ms),
      }),
    );
    const last = r.LastEvaluatedKey;
    const next_cursor: FollowCursor | null = last
      ? {
          created_at_ms: Number(last.created_at_ms),
          other_user_id: String(last.follower_user_id),
        }
      : null;
    return { items, next_cursor };
  }

  async listFollowing(
    user_id: string,
    opts: FollowsQueryOpts,
  ): Promise<FollowsPage> {
    // GSI1-follower — newest-first edges keyed on the follower.
    const exclusiveStartKey = opts.cursor
      ? {
          follower_user_id: user_id,
          followee_user_id: opts.cursor.other_user_id,
          created_at_ms: opts.cursor.created_at_ms,
        }
      : undefined;
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.followsTable,
        IndexName: "GSI1-follower",
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "follower_user_id" },
        ExpressionAttributeValues: { ":pk": user_id },
        ScanIndexForward: false,
        Limit: opts.limit,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items: FollowEdge[] = ((r.Items as FollowEdge[] | undefined) ?? []).map(
      (it) => ({
        follower_user_id: String(it.follower_user_id),
        follower_username: String(it.follower_username),
        followee_user_id: String(it.followee_user_id),
        followee_username: String(it.followee_username),
        created_at_ms: Number(it.created_at_ms),
      }),
    );
    const last = r.LastEvaluatedKey;
    const next_cursor: FollowCursor | null = last
      ? {
          created_at_ms: Number(last.created_at_ms),
          other_user_id: String(last.followee_user_id),
        }
      : null;
    return { items, next_cursor };
  }
}

interface CancellationReason {
  Code?: string;
}

function mapTransactError(e: unknown, op: "follow" | "unfollow"): unknown {
  if (typeof e !== "object" || e === null) return e;
  const name = (e as { name?: unknown }).name;
  if (name !== "TransactionCanceledException") return e;
  const reasons = (e as { CancellationReasons?: CancellationReason[] })
    .CancellationReasons;
  if (!Array.isArray(reasons)) return e;
  // Item 0 = follows-table guard; items 1+2 = users-table existence.
  if (reasons[0]?.Code === "ConditionalCheckFailed") {
    return op === "follow" ? new AlreadyFollowingError() : new NotFollowingError();
  }
  return e;
}

// -- In-memory (tests + dev) --------------------------------------------------

// Mirrors the DDB store but operates on a shared MemoryUserStore so the
// counter denormalisation is observable. The user store is required —
// without it the counts can't be kept in sync, and the handler tests
// rely on the counts to verify the unfollow→refollow round-trip.
export class MemoryFollowsStore implements FollowsStore {
  // (follower_user_id) → (followee_user_id → edge).
  private readonly byFollower = new Map<string, Map<string, FollowEdge>>();

  constructor(private readonly userStore: MemoryUserStore) {}

  async follow(args: FollowArgs): Promise<void> {
    const edges =
      this.byFollower.get(args.follower.user_id) ?? new Map<string, FollowEdge>();
    if (edges.has(args.followee.user_id)) throw new AlreadyFollowingError();
    edges.set(args.followee.user_id, {
      follower_user_id: args.follower.user_id,
      follower_username: args.follower.username,
      followee_user_id: args.followee.user_id,
      followee_username: args.followee.username,
      created_at_ms: args.created_at_ms,
    });
    this.byFollower.set(args.follower.user_id, edges);
    this.userStore.bumpFollowCounts(args.follower.email, "following_count", 1);
    this.userStore.bumpFollowCounts(args.followee.email, "follower_count", 1);
  }

  async unfollow(args: UnfollowArgs): Promise<void> {
    const edges = this.byFollower.get(args.follower.user_id);
    if (!edges || !edges.has(args.followee.user_id)) {
      throw new NotFollowingError();
    }
    edges.delete(args.followee.user_id);
    if (edges.size === 0) this.byFollower.delete(args.follower.user_id);
    this.userStore.bumpFollowCounts(args.follower.email, "following_count", -1);
    this.userStore.bumpFollowCounts(args.followee.email, "follower_count", -1);
  }

  async listFollowed(
    follower_user_id: string,
    target_user_ids: string[],
  ): Promise<string[]> {
    const edges = this.byFollower.get(follower_user_id);
    if (!edges) return [];
    const out: string[] = [];
    for (const id of target_user_ids) {
      if (edges.has(id)) out.push(id);
    }
    return out;
  }

  async listFollowers(
    user_id: string,
    opts: FollowsQueryOpts,
  ): Promise<FollowsPage> {
    const all: FollowEdge[] = [];
    for (const edges of this.byFollower.values()) {
      const edge = edges.get(user_id);
      if (edge) all.push(edge);
    }
    return this.page(all, opts, (e) => e.follower_user_id);
  }

  async listFollowing(
    user_id: string,
    opts: FollowsQueryOpts,
  ): Promise<FollowsPage> {
    const edges = this.byFollower.get(user_id);
    const all: FollowEdge[] = edges ? [...edges.values()] : [];
    return this.page(all, opts, (e) => e.followee_user_id);
  }

  private page(
    edges: FollowEdge[],
    opts: FollowsQueryOpts,
    otherSide: (e: FollowEdge) => string,
  ): FollowsPage {
    const sorted = [...edges].sort((a, b) => {
      if (b.created_at_ms !== a.created_at_ms) {
        return b.created_at_ms - a.created_at_ms;
      }
      return otherSide(b).localeCompare(otherSide(a));
    });
    let start = 0;
    if (opts.cursor) {
      const c = opts.cursor;
      start = sorted.findIndex(
        (e) =>
          e.created_at_ms < c.created_at_ms ||
          (e.created_at_ms === c.created_at_ms &&
            otherSide(e) < c.other_user_id),
      );
      if (start < 0) start = sorted.length;
    }
    const items = sorted.slice(start, start + opts.limit);
    const next_cursor: FollowCursor | null =
      start + opts.limit < sorted.length
        ? {
            created_at_ms: items[items.length - 1].created_at_ms,
            other_user_id: otherSide(items[items.length - 1]),
          }
        : null;
    return { items: items.map((e) => ({ ...e })), next_cursor };
  }
}
