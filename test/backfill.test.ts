import { strict as assert } from "node:assert";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  generateIdentity,
  pubKeyHex,
  signDrawingId,
  verifyDrawingId,
} from "../src/identity.js";
import { FsStorage } from "../ingest/storage.js";
import { backfillOwnership } from "../scripts/backfill-ownership.js";

interface DrawingEntry {
  id: string;
  pow: string;
  created_at: string;
  required_bits: number;
  solve_ms: number | null;
  bench_hps: number | null;
  parent: string | null;
  pubkey: string | null;
  signature: string | null;
}

function fakeId(seed: string): string {
  // 64 hex characters seeded by `seed` so each test entry has a stable id.
  let s = "";
  for (let i = 0; i < 32; i++) {
    const c = (seed.charCodeAt(i % seed.length) + i) & 0xff;
    s += c.toString(16).padStart(2, "0");
  }
  return s;
}

function baseEntry(id: string): DrawingEntry {
  return {
    id,
    pow: "00".repeat(32),
    created_at: "2026-04-01T12:00:00.000Z",
    required_bits: 12,
    solve_ms: 50,
    bench_hps: 1_000_000,
    parent: null,
    pubkey: null,
    signature: null,
  };
}

async function makeTmp(): Promise<{ root: string; storage: FsStorage }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "backfill-"));
  return { root, storage: new FsStorage(root) };
}

async function readIndex(root: string, day: string): Promise<DrawingEntry[]> {
  const text = await fs.readFile(path.join(root, "public/days", day, "index.jsonl"), "utf8");
  return text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as DrawingEntry);
}

test("backfill signs anonymous lines, leaves operator-signed alone, warns on foreign", async () => {
  const { root, storage } = await makeTmp();
  const operator = await generateIdentity();
  const operatorPubHex = await pubKeyHex(operator);
  const foreign = await generateIdentity();
  const foreignPubHex = await pubKeyHex(foreign);

  const anonId = fakeId("anonymous");
  const opId = fakeId("operator-already");
  const foreignId = fakeId("foreign-real-user");

  const anon = baseEntry(anonId); // pubkey + signature null
  const opSigned = baseEntry(opId);
  opSigned.pubkey = operatorPubHex;
  opSigned.signature = await signDrawingId(operator, opId);
  const foreignSigned = baseEntry(foreignId);
  foreignSigned.pubkey = foreignPubHex;
  foreignSigned.signature = await signDrawingId(foreign, foreignId);

  const day = "2026-04-01";
  const lines = [anon, opSigned, foreignSigned].map((e) => JSON.stringify(e)).join("\n") + "\n";
  await storage.put(`public/days/${day}/index.jsonl`, new TextEncoder().encode(lines), "application/jsonl");

  const logs: string[] = [];
  const report = await backfillOwnership({
    storage,
    operator,
    operatorPubHex,
    log: (m) => logs.push(m),
  });

  assert.equal(report.daysScanned, 1);
  assert.equal(report.daysModified, 1);
  assert.equal(report.signedCount, 1);
  assert.equal(report.alreadySignedCount, 1);
  assert.equal(report.foreignSkippedCount, 1);
  assert.equal(report.foreignResignedCount, 0);

  const after = await readIndex(root, day);
  const [a, o, f] = after;

  assert.equal(a.pubkey, operatorPubHex);
  assert.ok(a.signature && (await verifyDrawingId(operatorPubHex, a.id, a.signature)));

  assert.equal(o.pubkey, operatorPubHex);
  assert.equal(o.signature, opSigned.signature);

  assert.equal(f.pubkey, foreignPubHex);
  assert.equal(f.signature, foreignSigned.signature);
  assert.ok(await verifyDrawingId(foreignPubHex, f.id, f.signature!));
});

test("--force re-signs foreign-keyed lines under the operator", async () => {
  const { root, storage } = await makeTmp();
  const operator = await generateIdentity();
  const operatorPubHex = await pubKeyHex(operator);
  const foreign = await generateIdentity();
  const foreignPubHex = await pubKeyHex(foreign);

  const id = fakeId("foreign-only");
  const entry = baseEntry(id);
  entry.pubkey = foreignPubHex;
  entry.signature = await signDrawingId(foreign, id);

  const day = "2026-04-02";
  await storage.put(
    `public/days/${day}/index.jsonl`,
    new TextEncoder().encode(JSON.stringify(entry) + "\n"),
    "application/jsonl",
  );

  const report = await backfillOwnership({
    storage,
    operator,
    operatorPubHex,
    force: true,
  });

  assert.equal(report.foreignResignedCount, 1);
  assert.equal(report.foreignSkippedCount, 0);
  assert.equal(report.daysModified, 1);

  const [after] = await readIndex(root, day);
  assert.equal(after.pubkey, operatorPubHex);
  assert.ok(after.signature && (await verifyDrawingId(operatorPubHex, after.id, after.signature)));
});

test("re-running the backfill is a no-op", async () => {
  const { root, storage } = await makeTmp();
  const operator = await generateIdentity();
  const operatorPubHex = await pubKeyHex(operator);

  const id1 = fakeId("idem-one");
  const id2 = fakeId("idem-two");
  const day = "2026-04-03";
  const entries = [baseEntry(id1), baseEntry(id2)];
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await storage.put(`public/days/${day}/index.jsonl`, new TextEncoder().encode(lines), "application/jsonl");

  const first = await backfillOwnership({ storage, operator, operatorPubHex });
  assert.equal(first.signedCount, 2);
  assert.equal(first.daysModified, 1);

  const after1 = await fs.readFile(path.join(root, "public/days", day, "index.jsonl"));

  const second = await backfillOwnership({ storage, operator, operatorPubHex });
  assert.equal(second.signedCount, 0);
  assert.equal(second.daysModified, 0);
  assert.equal(second.alreadySignedCount, 2);

  const after2 = await fs.readFile(path.join(root, "public/days", day, "index.jsonl"));
  assert.deepEqual(after1, after2);
});

test("malformed lines are passed through untouched", async () => {
  const { root, storage } = await makeTmp();
  const operator = await generateIdentity();
  const operatorPubHex = await pubKeyHex(operator);

  const day = "2026-04-04";
  const valid = baseEntry(fakeId("good-one"));
  const text = JSON.stringify(valid) + "\n" + "{ this is not json\n";
  await storage.put(`public/days/${day}/index.jsonl`, new TextEncoder().encode(text), "application/jsonl");

  await backfillOwnership({ storage, operator, operatorPubHex });

  const raw = await fs.readFile(path.join(root, "public/days", day, "index.jsonl"), "utf8");
  // Garbage line preserved verbatim, valid line now signed by the operator.
  assert.match(raw, /^\{ this is not json$/m);
  const goodLine = raw.split("\n").find((l) => l.startsWith("{\""))!;
  const parsed = JSON.parse(goodLine) as DrawingEntry;
  assert.equal(parsed.pubkey, operatorPubHex);
  assert.ok(await verifyDrawingId(operatorPubHex, parsed.id, parsed.signature!));
});
