/// <reference types="@cloudflare/workers-types" />
import { handleIngest } from "./handler.js";
import { R2Storage } from "./r2-storage.js";
import { build } from "../builder/build.js";
import dayGalleryTpl from "../builder/templates/day-gallery.mustache";
import drawingTpl from "../builder/templates/drawing.mustache";
import indexTpl from "../builder/templates/index.mustache";
import feedTpl from "../builder/templates/feed.mustache";

export interface Env {
  BUCKET: R2Bucket;
  PUBLIC_BASE_URL: string; // editor URL, e.g. https://drawbang.pages.dev
  ALLOWED_ORIGIN?: string; // CORS allowlist; defaults to "*"
  BUILD_SECRET?: string; // optional; if set, POST /_build?secret=... runs the builder
}

const TEMPLATES = {
  dayGallery: dayGalleryTpl,
  drawing: drawingTpl,
  index: indexTpl,
  feed: feedTpl,
};

// Process-lifetime baseline grace window. Workers reuse instances within an
// isolate, so this gives ~minutes of in-memory tolerance for racing solvers
// even though the canonical state lives in R2.
const baselineHistory: string[] = [];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsOrigin = env.ALLOWED_ORIGIN ?? "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }

    if (request.method === "POST" && url.pathname === "/ingest") {
      let parsed: unknown;
      try {
        parsed = await request.json();
      } catch {
        return jsonResponse(400, { error: "bad json" }, corsOrigin);
      }
      const result = await handleIngest(parsed as never, {
        storage: new R2Storage(env.BUCKET),
        publicBaseUrl: env.PUBLIC_BASE_URL,
        baselineHistory,
      });
      return jsonResponse(result.status, result.body, corsOrigin);
    }

    if (request.method === "POST" && url.pathname === "/_build") {
      const secret = url.searchParams.get("secret");
      if (!env.BUILD_SECRET || secret !== env.BUILD_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const force = url.searchParams.get("force") === "1";
      const result = await runBuild(env, force);
      return jsonResponse(200, result, corsOrigin);
    }

    if (request.method === "GET" && url.pathname === "/state/last-publish.json") {
      const obj = await env.BUCKET.get("public/state/last-publish.json");
      const body = obj
        ? await obj.text()
        : JSON.stringify({ last_publish_at: "1970-01-01T00:00:00.000Z", last_difficulty_bits: 20 });
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "max-age=5, s-maxage=5",
          ...corsHeaders(corsOrigin),
        },
      });
    }

    return new Response("not found", { status: 404, headers: corsHeaders(corsOrigin) });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runBuild(env));
  },
};

async function runBuild(env: Env, forceRerender = false): Promise<{ sweptDrawings: number; touchedDays: string[] }> {
  const result = await build({
    storage: new R2Storage(env.BUCKET),
    publicBaseUrl: env.PUBLIC_BASE_URL,
    templates: TEMPLATES,
    logger: (m) => console.log(m),
    forceRerender,
  });
  console.log(
    `swept ${result.sweptDrawings} drawings, touched days: ${result.touchedDays.join(", ") || "(none)"}`,
  );
  return result;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(status: number, body: unknown, origin: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}
