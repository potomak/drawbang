// One-shot: reassign drawings that the migration bucketed under the
// "anonymous" sentinel to their real authors. Run once after operator
// review.
//
// Usage:
//   AWS_REGION=us-east-1 DRAWBANG_DRAWINGS_TABLE=drawbang-drawings \
//   npx tsx scripts/reassign-anonymous.ts [--dry-run]

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const dryRun = process.argv.includes("--dry-run");

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

const drawingsTable = required("DRAWBANG_DRAWINGS_TABLE");
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const POTOMAK = {
  user_id: "6dedb2698b5ba4d9b8c066d7187274f9450c114e6841faea4e4acbd2e9d96c30",
  username: "potomak",
};
const SONO_LA_GII = {
  user_id: "1efab20487171d0a39385d140b2cf12b060289453666693a783dcf742d20b053",
  username: "sono_la_gii",
};

// Operator-supplied: which legacy drawings belong to whom.
const SONO_DRAWINGS = new Set([
  "43b706cba32c205775edc4be7c73574255416774e942afd3f8640246f4c9e70e",
  "f56026a53427d28f4e761274aaf68a2237b0f2a616e8bf07bde97c1b968ffbac",
]);
const STAY_ANONYMOUS = new Set([
  "1f15286cf54f9941893cd828e29cfaece8bfaf24aa67180d8b98c89607a52af1",
]);

interface Assignee {
  user_id: string;
  username: string;
}

function ownerFor(drawing_id: string): Assignee | null {
  if (SONO_DRAWINGS.has(drawing_id)) return SONO_LA_GII;
  if (STAY_ANONYMOUS.has(drawing_id)) return null;
  // Everything else under anonymous was potomak.
  return POTOMAK;
}

async function* listAnonymous(): AsyncGenerator<string> {
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(
      new QueryCommand({
        TableName: drawingsTable,
        IndexName: "GSI2",
        KeyConditionExpression: "username = :u",
        ExpressionAttributeValues: { ":u": "anonymous" },
        ExclusiveStartKey,
      }),
    );
    for (const item of r.Items ?? []) {
      const id = (item as { drawing_id?: string }).drawing_id;
      if (id) yield id;
    }
    ExclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
}

async function main(): Promise<void> {
  const ids = [...new Set(await collect())];
  console.log(`found ${ids.length} drawings under "anonymous"${dryRun ? " (DRY RUN)" : ""}`);
  let kept = 0;
  const byOwner = new Map<string, number>();
  for (const id of ids) {
    const owner = ownerFor(id);
    if (!owner) {
      console.log(`  keep ${id.slice(0, 8)}: stays anonymous`);
      kept++;
      continue;
    }
    if (dryRun) {
      console.log(`  DRY: ${id.slice(0, 8)} → ${owner.username}`);
    } else {
      await doc.send(
        new UpdateCommand({
          TableName: drawingsTable,
          Key: { drawing_id: id },
          UpdateExpression: "SET username = :un, user_id = :uid",
          ExpressionAttributeValues: {
            ":un": owner.username,
            ":uid": owner.user_id,
          },
        }),
      );
      console.log(`  ${id.slice(0, 8)} → ${owner.username}`);
    }
    byOwner.set(owner.username, (byOwner.get(owner.username) ?? 0) + 1);
  }
  console.log(
    `done. kept ${kept} anonymous, ${[...byOwner.entries()]
      .map(([u, n]) => `${n} → ${u}`)
      .join(", ")}`,
  );
}

async function collect(): Promise<string[]> {
  const out: string[] = [];
  for await (const id of listAnonymous()) out.push(id);
  return out;
}

void main();
