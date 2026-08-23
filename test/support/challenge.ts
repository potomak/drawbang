import { solveChallenge } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import { MemoryChallengeStore } from "../../ingest/challenge-store.js";
import { mintChallenge, type ChallengeConfig } from "../../ingest/challenge.js";

// Shared setup for suites whose subject isn't the proof-of-work gate but
// which have to get past it (anything that registers an account).
//
// Not a *.test.ts file on purpose — the `test/**/*.test.ts` glob in
// package.json skips it, so it never runs as a suite of its own.

// A real challenge costs ~630ms to solve; at one per registration that
// would add minutes to the suite. This floors the difficulty to a couple
// of hash rounds. It changes the COST of the work, never whether the work
// is checked — there is no bypass flag, and the gate runs the same code
// either way. Production difficulty is exercised in challenge.test.ts.
export const TEST_DIFFICULTY = { cost: 1, counterMin: 0, counterMax: 2 };

export function testChallengeConfig(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  return {
    secret: "test-challenge-secret",
    challengeStore: new MemoryChallengeStore(),
    difficulty: TEST_DIFFICULTY,
    ...over,
  };
}

// Mints and solves a challenge, returning the base64 payload the browser
// widget would have submitted.
export async function solvedPayload(cfg: ChallengeConfig): Promise<string> {
  const challenge = await mintChallenge(cfg);
  const solution = await solveChallenge({ challenge, deriveKey });
  if (!solution) throw new Error("failed to solve test challenge");
  return Buffer.from(JSON.stringify({ challenge, solution })).toString("base64");
}
