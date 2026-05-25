import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { parseTileKey } from "../config/murals.js";

export class TileLockedError extends Error {
  readonly code = "TILE_LOCKED" as const;
  constructor() {
    super("tile is currently claimed by another account");
  }
}

export class ClaimExpiredError extends Error {
  readonly code = "CLAIM_EXPIRED" as const;
  constructor() {
    super("claim has expired");
  }
}

export class NotClaimerError extends Error {
  readonly code = "NOT_CLAIMER" as const;
  constructor() {
    super("publishing account is not the claimer of this tile");
  }
}

export class AlreadyPublishedError extends Error {
  readonly code = "ALREADY_PUBLISHED" as const;
  constructor() {
    super("tile already has a published drawing");
  }
}

export class CooldownError extends Error {
  readonly code = "COOLDOWN" as const;
  constructor(public readonly retry_after_s: number) {
    super(`cooldown active, retry in ${retry_after_s}s`);
  }
}

export interface TileRow {
  mural_id: string;
  tile_key: string;
  x: number;
  y: number;
  claimed_by?: string;
  claimed_at?: number;
  claim_expires_at?: number;
  drawing_id?: string;
  published_at?: number;
}

export interface ClaimArgs {
  mural_id: string;
  tile_key: string;
  user_id: string;
  now_epoch: number;
  ttl_s: number;
}

export interface PublishArgs {
  mural_id: string;
  tile_key: string;
  user_id: string;
  drawing_id: string;
  now_epoch: number;
  cooldown_s: number;
  cooldown_ttl_s: number; // how long the cooldown row should live (typically until mural closes)
}

export interface MuralStore {
  claimTile(args: ClaimArgs): Promise<{ claim_expires_at: number }>;
  publishTile(args: PublishArgs): Promise<void>;
  getTiles(mural_id: string): Promise<TileRow[]>;
  cooldownRemaining(
    user_id: string,
    mural_id: string,
    now_epoch: number,
    cooldown_s: number,
  ): Promise<number>;
}

function tileXY(tile_key: string): { x: number; y: number } {
  const parsed = parseTileKey(tile_key);
  if (!parsed) throw new Error(`invalid tile_key: ${tile_key}`);
  return parsed;
}

// -- DynamoDB -----------------------------------------------------------------

export interface DynamoMuralStoreOptions {
  tilesTable: string;
  cooldownsTable: string;
  client?: DynamoDBDocumentClient;
}

export class DynamoMuralStore implements MuralStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tilesTable: string;
  private readonly cooldownsTable: string;

  constructor(opts: DynamoMuralStoreOptions) {
    this.tilesTable = opts.tilesTable;
    this.cooldownsTable = opts.cooldownsTable;
    this.doc =
      opts.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async claimTile(args: ClaimArgs): Promise<{ claim_expires_at: number }> {
    const claim_expires_at = args.now_epoch + args.ttl_s;
    const { x, y } = tileXY(args.tile_key);
    // Reserve the row by Update with a condition that allows: fresh tile,
    // expired tile, or refresh by the same pubkey. Reject anything that has
    // already been published (drawing_id set).
    const tx: TransactWriteCommandInput = {
      TransactItems: [
        {
          Update: {
            TableName: this.tilesTable,
            Key: { mural_id: args.mural_id, tile_key: args.tile_key },
            UpdateExpression:
              "SET claimed_by = :user_id, claimed_at = :now, claim_expires_at = :exp, x = :x, y = :y, ttl_epoch = :ttl",
            ConditionExpression:
              "attribute_not_exists(drawing_id) AND (attribute_not_exists(claimed_by) OR claim_expires_at <= :now OR claimed_by = :user_id)",
            ExpressionAttributeValues: {
              ":user_id": args.user_id,
              ":now": args.now_epoch,
              ":exp": claim_expires_at,
              ":x": x,
              ":y": y,
              ":ttl": claim_expires_at + 7 * 86_400,
            },
          },
        },
      ],
    };
    try {
      await this.doc.send(new TransactWriteCommand(tx));
    } catch (err: any) {
      if (
        err?.name === "TransactionCanceledException" ||
        err?.name === "ConditionalCheckFailedException"
      ) {
        // Either someone else holds it OR it's already published.
        const existing = await this.doc.send(
          new GetCommand({
            TableName: this.tilesTable,
            Key: { mural_id: args.mural_id, tile_key: args.tile_key },
          }),
        );
        if (existing.Item?.drawing_id) throw new AlreadyPublishedError();
        throw new TileLockedError();
      }
      throw err;
    }
    return { claim_expires_at };
  }

  async publishTile(args: PublishArgs): Promise<void> {
    const cooldown_deadline = args.now_epoch - args.cooldown_s;
    const tx: TransactWriteCommandInput = {
      TransactItems: [
        {
          Update: {
            TableName: this.tilesTable,
            Key: { mural_id: args.mural_id, tile_key: args.tile_key },
            UpdateExpression:
              "SET drawing_id = :did, published_at = :now",
            ConditionExpression:
              "claimed_by = :user_id AND claim_expires_at > :now AND attribute_not_exists(drawing_id)",
            ExpressionAttributeValues: {
              ":did": args.drawing_id,
              ":user_id": args.user_id,
              ":now": args.now_epoch,
            },
          },
        },
        {
          Update: {
            TableName: this.cooldownsTable,
            Key: { user_id: args.user_id, mural_id: args.mural_id },
            UpdateExpression: "SET last_publish_at = :now, ttl_epoch = :ttl",
            ConditionExpression:
              "attribute_not_exists(last_publish_at) OR last_publish_at <= :deadline",
            ExpressionAttributeValues: {
              ":now": args.now_epoch,
              ":deadline": cooldown_deadline,
              ":ttl": args.now_epoch + args.cooldown_ttl_s,
            },
          },
        },
      ],
    };
    try {
      await this.doc.send(new TransactWriteCommand(tx));
    } catch (err: any) {
      if (
        err?.name === "TransactionCanceledException" ||
        err?.name === "ConditionalCheckFailedException"
      ) {
        // Inspect cancellation reasons to surface the right error.
        const reasons: Array<{ Code?: string } | undefined> =
          err.CancellationReasons ?? [];
        // [0] = tile row, [1] = cooldown row.
        const tileFailed = reasons[0]?.Code === "ConditionalCheckFailed";
        const cooldownFailed = reasons[1]?.Code === "ConditionalCheckFailed";
        if (cooldownFailed && !tileFailed) {
          const remaining = await this.cooldownRemaining(
            args.user_id,
            args.mural_id,
            args.now_epoch,
            args.cooldown_s,
          );
          throw new CooldownError(remaining);
        }
        // Inspect the tile to disambiguate.
        const existing = await this.doc.send(
          new GetCommand({
            TableName: this.tilesTable,
            Key: { mural_id: args.mural_id, tile_key: args.tile_key },
          }),
        );
        const row = existing.Item as TileRow | undefined;
        if (row?.drawing_id) throw new AlreadyPublishedError();
        if (!row?.claimed_by) throw new NotClaimerError();
        if (row.claimed_by !== args.user_id) throw new NotClaimerError();
        if ((row.claim_expires_at ?? 0) <= args.now_epoch) {
          throw new ClaimExpiredError();
        }
        // Fall through: shouldn't happen, but be loud.
        throw err;
      }
      throw err;
    }
  }

  async getTiles(mural_id: string): Promise<TileRow[]> {
    const out: TileRow[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new QueryCommand({
          TableName: this.tilesTable,
          KeyConditionExpression: "mural_id = :c",
          ExpressionAttributeValues: { ":c": mural_id },
          ExclusiveStartKey,
        }),
      );
      for (const item of r.Items ?? []) {
        out.push(item as TileRow);
      }
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  async cooldownRemaining(
    user_id: string,
    mural_id: string,
    now_epoch: number,
    cooldown_s: number,
  ): Promise<number> {
    const r = await this.doc.send(
      new GetCommand({
        TableName: this.cooldownsTable,
        Key: { user_id, mural_id },
      }),
    );
    const last = r.Item?.last_publish_at as number | undefined;
    if (!last) return 0;
    return Math.max(0, last + cooldown_s - now_epoch);
  }
}

// -- In-memory ----------------------------------------------------------------

export class MemoryMuralStore implements MuralStore {
  private readonly tiles = new Map<string, Map<string, TileRow>>();
  private readonly cooldowns = new Map<string, number>();

  private muralMap(mural_id: string): Map<string, TileRow> {
    let m = this.tiles.get(mural_id);
    if (!m) {
      m = new Map();
      this.tiles.set(mural_id, m);
    }
    return m;
  }

  private cooldownKey(user_id: string, mural_id: string): string {
    return `${user_id}:${mural_id}`;
  }

  // Note: no `await` between read and write so the JS event loop can't
  // interleave two concurrent claims — matches the DDB conditional-write
  // contract (exactly one of N parallel claims wins).
  async claimTile(args: ClaimArgs): Promise<{ claim_expires_at: number }> {
    const map = this.muralMap(args.mural_id);
    const existing = map.get(args.tile_key);
    if (existing?.drawing_id) throw new AlreadyPublishedError();
    const activeClaim =
      existing?.claim_expires_at && existing.claim_expires_at > args.now_epoch;
    if (activeClaim && existing!.claimed_by !== args.user_id) {
      throw new TileLockedError();
    }
    const { x, y } = tileXY(args.tile_key);
    const claim_expires_at = args.now_epoch + args.ttl_s;
    map.set(args.tile_key, {
      ...(existing ?? {}),
      mural_id: args.mural_id,
      tile_key: args.tile_key,
      x,
      y,
      claimed_by: args.user_id,
      claimed_at: args.now_epoch,
      claim_expires_at,
    });
    return { claim_expires_at };
  }

  async publishTile(args: PublishArgs): Promise<void> {
    const map = this.muralMap(args.mural_id);
    const existing = map.get(args.tile_key);
    if (!existing || !existing.claimed_by) throw new NotClaimerError();
    if (existing.drawing_id) throw new AlreadyPublishedError();
    if (existing.claimed_by !== args.user_id) throw new NotClaimerError();
    if ((existing.claim_expires_at ?? 0) <= args.now_epoch) {
      throw new ClaimExpiredError();
    }
    const cooldownLast = this.cooldowns.get(
      this.cooldownKey(args.user_id, args.mural_id),
    );
    if (cooldownLast !== undefined) {
      const elapsed = args.now_epoch - cooldownLast;
      if (elapsed < args.cooldown_s) {
        throw new CooldownError(args.cooldown_s - elapsed);
      }
    }
    map.set(args.tile_key, {
      ...existing,
      drawing_id: args.drawing_id,
      published_at: args.now_epoch,
    });
    this.cooldowns.set(
      this.cooldownKey(args.user_id, args.mural_id),
      args.now_epoch,
    );
  }

  async getTiles(mural_id: string): Promise<TileRow[]> {
    return [...this.muralMap(mural_id).values()];
  }

  async cooldownRemaining(
    user_id: string,
    mural_id: string,
    now_epoch: number,
    cooldown_s: number,
  ): Promise<number> {
    const last = this.cooldowns.get(this.cooldownKey(user_id, mural_id));
    if (last === undefined) return 0;
    return Math.max(0, last + cooldown_s - now_epoch);
  }
}
