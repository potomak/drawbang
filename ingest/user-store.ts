import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

// Account records for the email/password identity. Two tables back the Dynamo
// implementation: a users table keyed by email and a usernames reservation
// table keyed by username. register() writes both in a single
// TransactWriteItems so email AND username uniqueness are enforced atomically
// (same multi-row-write rule as the canvas store).
//
// At runtime the only lookups are by email (login + reset); publish/claim trust
// the self-contained JWT, so neither user_id nor username needs a reverse index.

export interface UserRecord {
  email: string; // lowercased — PK of the users table
  user_id: string; // random 64-hex, stable public id (URLs key on username)
  username: string; // lowercased, unique, immutable in v1
  password_hash: string;
  token_version: number; // bumped on password reset → invalidates reset links
  created_at: string; // ISO-8601
  // drawing_id of the gif the account chose as its profile picture. Validated
  // against DrawingStore at write time so users can only pin their own
  // drawings. null/absent → no profile picture rendered (placeholder used).
  profile_picture_drawing_id?: string;
  // Denormalised follow counts (#202). Maintained by FollowsStore via
  // TransactWrite on follow/unfollow. Absent on rows pre-dating the
  // follows table — readers treat absent as 0.
  follower_count?: number;
  following_count?: number;
  // Public profile fields editable via POST /auth/profile. Both are
  // optional; absent → nothing rendered on /u/<username>. The handler
  // validates lengths + protocol before write, so readers can treat
  // these as pre-sanitised plain text + http(s) URL.
  bio?: string;
  link?: string;
}

// A UserRecord without the password hash. Everything the operator views
// on /admin goes through this shape so a credential can never ride along
// with a listing by accident.
export type UserSummary = Omit<UserRecord, "password_hash" | "token_version">;

export interface UserListPage {
  users: UserSummary[];
  // True when the listing stopped at `limit` — more accounts exist.
  truncated: boolean;
}

// Accounts are low-cardinality, but "low" isn't "bounded" — the default
// caps one listing so a table scan can't grow past a Lambda timeout as
// the site grows.
export const DEFAULT_USER_LIST_LIMIT = 500;

export class EmailTakenError extends Error {
  constructor() {
    super("email already registered");
    this.name = "EmailTakenError";
  }
}

export class UsernameTakenError extends Error {
  constructor() {
    super("username already taken");
    this.name = "UsernameTakenError";
  }
}

export class TokenVersionMismatchError extends Error {
  constructor() {
    super("reset token is no longer valid");
    this.name = "TokenVersionMismatchError";
  }
}

export class UserNotFoundError extends Error {
  constructor() {
    super("user not found");
    this.name = "UserNotFoundError";
  }
}

export interface UserStore {
  // Atomically reserves email + username. Throws EmailTakenError /
  // UsernameTakenError on conflict.
  register(rec: UserRecord): Promise<UserRecord>;
  // Mirror of register(): drops the account row and frees the username
  // reservation in one transaction. Conditioned on user_id so a stale
  // session can never delete an account that was already deleted and
  // re-registered under the same email. Throws UserNotFoundError when the
  // row is missing or the user_id no longer matches.
  deleteAccount(args: {
    email: string;
    username: string;
    user_id: string;
  }): Promise<void>;
  getByEmail(email: string): Promise<UserRecord | null>;
  // Lists accounts for the operator view on /admin. Unordered — callers
  // sort. Never returns password_hash (see UserSummary); the Dynamo
  // implementation leaves it out of the projection so it doesn't even
  // cross the wire.
  listUsers(opts?: { limit?: number }): Promise<UserListPage>;
  // Resolves a public handle to the underlying account. Returns null when
  // the handle is unregistered. Used by the dynamic /u/<username> profile
  // route to render an empty profile page for an account that has no
  // published drawings yet (instead of 404).
  getByUsername(username: string): Promise<UserRecord | null>;
  // Sets a new password_hash, conditional on token_version === expected, and
  // bumps token_version (single-use reset). Throws TokenVersionMismatchError
  // if the row is missing or the version no longer matches.
  updatePassword(
    email: string,
    passwordHash: string,
    expectedTokenVersion: number,
    nowIso: string,
  ): Promise<UserRecord>;
  // Sets the user's profile picture to the given drawing id. Caller is
  // responsible for validating ownership BEFORE invoking this — the store
  // just writes. Pass null to clear.
  setProfilePicture(email: string, drawing_id: string | null): Promise<UserRecord>;
  // Sets the public profile fields. Each field is independently set
  // (non-null string) or removed (null). Caller is responsible for
  // validation (length, URL scheme) before invoking. Throws
  // UserNotFoundError when the email isn't registered.
  updateProfile(
    email: string,
    fields: { bio: string | null; link: string | null },
  ): Promise<UserRecord>;
}

// -- DynamoDB -----------------------------------------------------------------

export interface DynamoUserStoreOptions {
  usersTable: string;
  usernamesTable: string;
  client?: DynamoDBDocumentClient;
}

export class DynamoUserStore implements UserStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly usersTable: string;
  private readonly usernamesTable: string;

  constructor(opts: DynamoUserStoreOptions) {
    this.usersTable = opts.usersTable;
    this.usernamesTable = opts.usernamesTable;
    this.doc =
      opts.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async register(rec: UserRecord): Promise<UserRecord> {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.usersTable,
                Item: { ...rec },
                ConditionExpression: "attribute_not_exists(email)",
              },
            },
            {
              Put: {
                TableName: this.usernamesTable,
                Item: { username: rec.username, email: rec.email },
                ConditionExpression: "attribute_not_exists(username)",
              },
            },
          ],
        }),
      );
      return rec;
    } catch (e) {
      const reasons = (e as { CancellationReasons?: { Code?: string }[] })
        .CancellationReasons;
      if (Array.isArray(reasons)) {
        if (reasons[0]?.Code === "ConditionalCheckFailed") {
          throw new EmailTakenError();
        }
        if (reasons[1]?.Code === "ConditionalCheckFailed") {
          throw new UsernameTakenError();
        }
      }
      throw e;
    }
  }

  async deleteAccount(args: {
    email: string;
    username: string;
    user_id: string;
  }): Promise<void> {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.usersTable,
                Key: { email: args.email },
                ConditionExpression: "user_id = :uid",
                ExpressionAttributeValues: { ":uid": args.user_id },
              },
            },
            {
              // Freeing the handle is safe: follow edges key on user_id, so
              // a future account claiming the same username inherits
              // nothing from this one.
              Delete: {
                TableName: this.usernamesTable,
                Key: { username: args.username },
                ConditionExpression: "email = :email",
                ExpressionAttributeValues: { ":email": args.email },
              },
            },
          ],
        }),
      );
    } catch (e) {
      const reasons = (e as { CancellationReasons?: { Code?: string }[] })
        .CancellationReasons;
      if (Array.isArray(reasons) && reasons.some((r) => r?.Code === "ConditionalCheckFailed")) {
        throw new UserNotFoundError();
      }
      throw e;
    }
  }

  async getByEmail(email: string): Promise<UserRecord | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.usersTable, Key: { email } }),
    );
    return r.Item ? (r.Item as UserRecord) : null;
  }

  // 2-hop: usernames table (username PK) gives us the email, then the
  // users table gives us the full record. Both calls are GetItem (sub-ms
  // p50). Profile pageloads are aggressively edge-cached so this only
  // runs on cache misses.
  async getByUsername(username: string): Promise<UserRecord | null> {
    const r1 = await this.doc.send(
      new GetCommand({ TableName: this.usernamesTable, Key: { username } }),
    );
    const email = (r1.Item as { email?: string } | undefined)?.email;
    if (!email) return null;
    return this.getByEmail(email);
  }

  // Paginated scan of the accounts table. There's no index on created_at,
  // so ordering by signup date means reading every row — fine at this
  // cardinality, and capped by `limit` so it stays fine. Revisit (GSI on a
  // constant partition + created_at sort key) if the cap ever bites.
  async listUsers(opts: { limit?: number } = {}): Promise<UserListPage> {
    const limit = Math.max(1, opts.limit ?? DEFAULT_USER_LIST_LIMIT);
    const users: UserSummary[] = [];
    let lastKey: Record<string, unknown> | undefined;
    let truncated = false;
    do {
      const r = await this.doc.send(
        new ScanCommand({
          TableName: this.usersTable,
          // password_hash is deliberately absent — it never leaves Dynamo
          // for this call path. Aliased names sidestep the reserved-word
          // list entirely.
          ProjectionExpression:
            "#email, #user_id, #username, #created_at, #ppd, #fc, #gc, #bio, #link",
          ExpressionAttributeNames: {
            "#email": "email",
            "#user_id": "user_id",
            "#username": "username",
            "#created_at": "created_at",
            "#ppd": "profile_picture_drawing_id",
            "#fc": "follower_count",
            "#gc": "following_count",
            "#bio": "bio",
            "#link": "link",
          },
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const item of r.Items ?? []) {
        if (users.length >= limit) {
          truncated = true;
          break;
        }
        const summary = toUserSummary(item);
        if (summary) users.push(summary);
      }
      if (truncated) break;
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return { users, truncated };
  }

  async updatePassword(
    email: string,
    passwordHash: string,
    expectedTokenVersion: number,
    nowIso: string,
  ): Promise<UserRecord> {
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.usersTable,
          Key: { email },
          UpdateExpression:
            "SET password_hash = :ph, token_version = :next, updated_at = :now",
          ConditionExpression: "token_version = :expected",
          ExpressionAttributeValues: {
            ":ph": passwordHash,
            ":next": expectedTokenVersion + 1,
            ":expected": expectedTokenVersion,
            ":now": nowIso,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return r.Attributes as UserRecord;
    } catch (e) {
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") {
        throw new TokenVersionMismatchError();
      }
      throw e;
    }
  }

  async setProfilePicture(
    email: string,
    drawing_id: string | null,
  ): Promise<UserRecord> {
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.usersTable,
          Key: { email },
          UpdateExpression: drawing_id
            ? "SET profile_picture_drawing_id = :p"
            : "REMOVE profile_picture_drawing_id",
          ConditionExpression: "attribute_exists(email)",
          ExpressionAttributeValues: drawing_id
            ? { ":p": drawing_id }
            : undefined,
          ReturnValues: "ALL_NEW",
        }),
      );
      return r.Attributes as UserRecord;
    } catch (e) {
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") {
        throw new UserNotFoundError();
      }
      throw e;
    }
  }

  async updateProfile(
    email: string,
    fields: { bio: string | null; link: string | null },
  ): Promise<UserRecord> {
    const sets: string[] = [];
    const removes: string[] = [];
    const values: Record<string, unknown> = {};
    if (fields.bio === null) {
      removes.push("bio");
    } else {
      sets.push("bio = :bio");
      values[":bio"] = fields.bio;
    }
    if (fields.link === null) {
      removes.push("link");
    } else {
      sets.push("link = :link");
      values[":link"] = fields.link;
    }
    const parts: string[] = [];
    if (sets.length) parts.push(`SET ${sets.join(", ")}`);
    if (removes.length) parts.push(`REMOVE ${removes.join(", ")}`);
    try {
      const r = await this.doc.send(
        new UpdateCommand({
          TableName: this.usersTable,
          Key: { email },
          UpdateExpression: parts.join(" "),
          ConditionExpression: "attribute_exists(email)",
          ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
          ReturnValues: "ALL_NEW",
        }),
      );
      return r.Attributes as UserRecord;
    } catch (e) {
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") {
        throw new UserNotFoundError();
      }
      throw e;
    }
  }
}

// A row missing email/username/user_id can't be rendered or linked, so it's
// dropped rather than rendered half-blank.
function toUserSummary(item: Record<string, unknown>): UserSummary | null {
  const email = item.email;
  const user_id = item.user_id;
  const username = item.username;
  if (typeof email !== "string" || typeof user_id !== "string") return null;
  if (typeof username !== "string") return null;
  const out: UserSummary = {
    email,
    user_id,
    username,
    created_at: typeof item.created_at === "string" ? item.created_at : "",
  };
  if (typeof item.profile_picture_drawing_id === "string") {
    out.profile_picture_drawing_id = item.profile_picture_drawing_id;
  }
  if (typeof item.follower_count === "number") out.follower_count = item.follower_count;
  if (typeof item.following_count === "number") out.following_count = item.following_count;
  if (typeof item.bio === "string") out.bio = item.bio;
  if (typeof item.link === "string") out.link = item.link;
  return out;
}

// -- In-memory (tests + dev) --------------------------------------------------

export class MemoryUserStore implements UserStore {
  private readonly byEmail = new Map<string, UserRecord>();
  private readonly usernames = new Set<string>();

  async register(rec: UserRecord): Promise<UserRecord> {
    if (this.byEmail.has(rec.email)) throw new EmailTakenError();
    if (this.usernames.has(rec.username)) throw new UsernameTakenError();
    this.byEmail.set(rec.email, { ...rec });
    this.usernames.add(rec.username);
    return rec;
  }

  async deleteAccount(args: {
    email: string;
    username: string;
    user_id: string;
  }): Promise<void> {
    const rec = this.byEmail.get(args.email);
    if (!rec || rec.user_id !== args.user_id) throw new UserNotFoundError();
    this.byEmail.delete(args.email);
    this.usernames.delete(args.username);
  }

  async getByEmail(email: string): Promise<UserRecord | null> {
    const r = this.byEmail.get(email);
    return r ? { ...r } : null;
  }

  async listUsers(opts: { limit?: number } = {}): Promise<UserListPage> {
    const limit = Math.max(1, opts.limit ?? DEFAULT_USER_LIST_LIMIT);
    const all = [...this.byEmail.values()];
    const users = all.slice(0, limit).map((rec) => {
      const { password_hash: _hash, token_version: _tv, ...summary } = rec;
      return summary;
    });
    return { users, truncated: all.length > limit };
  }

  async getByUsername(username: string): Promise<UserRecord | null> {
    if (!this.usernames.has(username)) return null;
    for (const rec of this.byEmail.values()) {
      if (rec.username === username) return { ...rec };
    }
    return null;
  }

  async updatePassword(
    email: string,
    passwordHash: string,
    expectedTokenVersion: number,
    _nowIso: string,
  ): Promise<UserRecord> {
    const r = this.byEmail.get(email);
    if (!r || r.token_version !== expectedTokenVersion) {
      throw new TokenVersionMismatchError();
    }
    const updated: UserRecord = {
      ...r,
      password_hash: passwordHash,
      token_version: r.token_version + 1,
    };
    this.byEmail.set(email, updated);
    return { ...updated };
  }

  async setProfilePicture(
    email: string,
    drawing_id: string | null,
  ): Promise<UserRecord> {
    const r = this.byEmail.get(email);
    if (!r) throw new UserNotFoundError();
    const { profile_picture_drawing_id: _drop, ...rest } = r;
    const updated: UserRecord = drawing_id
      ? { ...rest, profile_picture_drawing_id: drawing_id }
      : rest;
    this.byEmail.set(email, updated);
    return { ...updated };
  }

  async updateProfile(
    email: string,
    fields: { bio: string | null; link: string | null },
  ): Promise<UserRecord> {
    const r = this.byEmail.get(email);
    if (!r) throw new UserNotFoundError();
    const { bio: _bio, link: _link, ...rest } = r;
    const updated: UserRecord = { ...rest };
    if (fields.bio !== null) updated.bio = fields.bio;
    if (fields.link !== null) updated.link = fields.link;
    this.byEmail.set(email, updated);
    return { ...updated };
  }

  // Test seam for MemoryFollowsStore. Adjusts the follower/following
  // counters by `delta` on a single row, clamping at 0 to mirror the
  // ADD-with-clamp behaviour MemoryLikesStore uses for like_count. Throws
  // UserNotFoundError when the email isn't registered.
  bumpFollowCounts(
    email: string,
    field: "follower_count" | "following_count",
    delta: number,
  ): void {
    const r = this.byEmail.get(email);
    if (!r) throw new UserNotFoundError();
    const next = Math.max(0, (r[field] ?? 0) + delta);
    this.byEmail.set(email, { ...r, [field]: next });
  }
}
