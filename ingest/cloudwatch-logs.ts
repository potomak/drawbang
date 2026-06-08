import type {
  CloudWatchLogsClient,
  GetQueryResultsCommandOutput,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  GetQueryResultsCommand,
  StartQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";

// Thin wrapper around Insights so the admin handler doesn't have to
// hand-roll the StartQuery → poll → reshape loop, and tests can stub a
// single function. The SDK returns each row as `[{field, value}, …]`;
// we reshape into `Record<string, string>` because every consumer here
// wants column-indexed access.

export interface InsightsRow {
  [field: string]: string;
}

export interface RunInsightsQueryArgs {
  client: Pick<CloudWatchLogsClient, "send">;
  logGroup: string;
  query: string;
  startMs: number;
  endMs: number;
  // How long to wait for the query to finish before giving up. Insights
  // queries over our log volume return in a few seconds; 30s is generous.
  timeoutMs?: number;
  // How long to wait between GetQueryResults polls.
  pollIntervalMs?: number;
}

export class InsightsTimeoutError extends Error {
  constructor(queryId: string) {
    super(`insights query ${queryId} did not finish within timeout`);
    this.name = "InsightsTimeoutError";
  }
}

export async function runInsightsQuery(
  args: RunInsightsQueryArgs,
): Promise<InsightsRow[]> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const pollIntervalMs = args.pollIntervalMs ?? 500;

  const startCmd = new StartQueryCommand({
    logGroupName: args.logGroup,
    startTime: Math.floor(args.startMs / 1000),
    endTime: Math.floor(args.endMs / 1000),
    queryString: args.query,
  });
  const started = await args.client.send(startCmd as never);
  const queryId =
    (started as unknown as { queryId?: string }).queryId ?? "";
  if (!queryId) throw new Error("insights StartQuery returned no queryId");

  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const out = (await args.client.send(
      new GetQueryResultsCommand({ queryId }) as never,
    )) as unknown as GetQueryResultsCommandOutput;
    const status = out.status;
    if (status === "Complete") {
      return (out.results ?? []).map((row) => {
        const obj: InsightsRow = {};
        for (const cell of row ?? []) {
          if (cell.field && cell.value !== undefined) {
            obj[cell.field] = cell.value;
          }
        }
        return obj;
      });
    }
    if (status === "Failed" || status === "Cancelled" || status === "Timeout") {
      throw new Error(`insights query ${queryId} ended with status ${status}`);
    }
    if (Date.now() >= deadline) {
      throw new InsightsTimeoutError(queryId);
    }
    await sleep(pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
