import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

// Single-use guard for solved ALTCHA challenges, backed by
// `drawbang-challenges`: PK=challenge_id (the challenge nonce), plus a
// numeric `expires_at` that DynamoDB's TTL sweeps.
//
// **This is what makes the proof-of-work gate mean anything.** ALTCHA's
// verifySolution() proves a solution is valid for a challenge; it does NOT
// know whether that solution was already spent. Without this store a
// spammer solves ONE challenge and replays the same payload for every
// registration inside the 10-minute expiry window — the PoW cost gets
// amortised to nothing and the gate is decorative. With it, every account
// costs its own solve.
//
// claim() is deliberately a single conditional PutItem rather than the
// read-then-write the altcha-lib framework helpers use for their `store`
// option. Two concurrent replays of the same payload both pass a
// get-then-set; exactly one wins a conditional put. That race is the whole
// attack, so the check has to be atomic — which is why the gate calls
// verifySolution() directly instead of going through
// `altcha-lib/frameworks/shared`.

export interface ChallengeStore {
  // Marks a challenge id as spent. Returns true when THIS caller claimed
  // it (first use) and false when it was already spent (replay).
  //
  // expires_at is a unix timestamp in SECONDS — DynamoDB TTL ignores
  // milliseconds, and a row that never expires is a slow leak.
  claim(challenge_id: string, expires_at_s: number): Promise<boolean>;
}

export interface DynamoChallengeStoreOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
}

export class DynamoChallengeStore implements ChallengeStore {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(opts: DynamoChallengeStoreOptions) {
    this.tableName = opts.tableName;
    this.doc = opts.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async claim(challenge_id: string, expires_at_s: number): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { challenge_id, expires_at: expires_at_s },
          ConditionExpression: "attribute_not_exists(challenge_id)",
        }),
      );
      return true;
    } catch (e) {
      if ((e as { name?: unknown }).name === "ConditionalCheckFailedException") {
        return false;
      }
      throw e;
    }
  }
}

// -- In-memory (tests + dev) --------------------------------------------------

export class MemoryChallengeStore implements ChallengeStore {
  readonly claimed = new Map<string, number>();

  async claim(challenge_id: string, expires_at_s: number): Promise<boolean> {
    if (this.claimed.has(challenge_id)) return false;
    this.claimed.set(challenge_id, expires_at_s);
    return true;
  }
}
