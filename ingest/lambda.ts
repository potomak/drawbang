import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";
import { handleIngest, type IngestRequest } from "./handler.js";
import { S3Storage } from "./s3-storage.js";

const bucket = required("DRAWBANG_BUCKET");
const publicBaseUrl = required("PUBLIC_BASE_URL");
const drawingsBaseUrl = required("DRAWINGS_BASE_URL");
const siteBase = required("SITE_BASE");

// Reused across invocations in a warm Lambda container. Cold start pays the
// SDK init cost once; subsequent requests reuse the connection pool.
const storage = new S3Storage({ bucket });

// Module-scope rolling baseline window. Survives within a single warm
// container but not across containers — the handler already treats this as
// best-effort (see CLAUDE.md invariants).
const baselineHistory: string[] = [];

export async function handler(
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyResultV2> {
  if (event.requestContext.http.method !== "POST") {
    return text(405, "method not allowed");
  }

  let body: IngestRequest;
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body ?? "";
    body = JSON.parse(raw) as IngestRequest;
  } catch {
    return json(400, { error: "bad json body" });
  }

  const result = await handleIngest(body, {
    storage,
    publicBaseUrl,
    drawingsBaseUrl,
    siteBase,
    baselineHistory,
  });
  return json(result.status, result.body);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

function json(status: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function text(status: number, body: string): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { "Content-Type": "text/plain" },
    body,
  };
}
