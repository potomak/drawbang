/// <reference types="@cloudflare/workers-types" />
import { handleIngest } from "../ingest/handler.js";
import { R2Storage } from "../ingest/r2-storage.js";

interface Env {
  BUCKET: R2Bucket;
  PUBLIC_BASE_URL?: string;
}

const baselineHistory: string[] = [];

export const onRequestPost: PagesFunction<Env> = async (context) => {
  let parsed: unknown;
  try {
    parsed = await context.request.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const result = await handleIngest(parsed as never, {
    storage: new R2Storage(context.env.BUCKET),
    publicBaseUrl: context.env.PUBLIC_BASE_URL ?? new URL(context.request.url).origin,
    baselineHistory,
  });
  return Response.json(result.body, { status: result.status });
};
