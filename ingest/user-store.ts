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
}

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

export interface UserStore {
  // Atomically reserves email + username. Throws EmailTakenError /
  // UsernameTakenError on conflict.
  register(rec: UserRecord): Promise<UserRecord>;
  getByEmail(email: string): Promise<UserRecord | null>;
  // Sets a new password_hash, conditional on token_version === expected, and
  // bumps token_version (single-use reset). Throws TokenVersionMismatchError
  // if the row is missing or the version no longer matches.
  updatePassword(
    email: string,
    passwordHash: string,
    expectedTokenVersion: number,
    nowIso: string,
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

  async getByEmail(email: string): Promise<UserRecord | null> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.usersTable, Key: { email } }),
    );
    return r.Item ? (r.Item as UserRecord) : null;
  }

  // Full scan of the accounts table, projecting just the public handle + id.
  // Used by the builder to render a profile page for every account, even one
  // with no published drawings yet. Accounts are low-cardinality, so a scan is
  // fine; revisit (GSI/paginated listing) only if that stops being true.
  async listAccounts(): Promise<Array<{ username: string; user_id: string }>> {
    const out: Array<{ username: string; user_id: string }> = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(
        new ScanCommand({
          TableName: this.usersTable,
          ProjectionExpression: "username, user_id",
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const item of r.Items ?? []) {
        const username = (item as { username?: string }).username;
        const user_id = (item as { user_id?: string }).user_id;
        if (username && user_id) out.push({ username, user_id });
      }
      lastKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return out;
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

  async getByEmail(email: string): Promise<UserRecord | null> {
    const r = this.byEmail.get(email);
    return r ? { ...r } : null;
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
}
