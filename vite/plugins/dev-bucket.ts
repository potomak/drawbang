import type { Plugin } from "vite";
import { promises as fs } from "node:fs";
import path from "node:path";

// Dev-only middleware that mirrors the prod CloudFront Function (see
// infra/aws/template.yaml RewriteCleanUrls) so clean URLs work against the
// Vite dev server. Two responsibilities:
//
//   1. Serve builder-rendered HTML from ./dev-bucket/public/<...>.html for
//      /gallery, /d/<id>, /days/<date>/p/<n>, /u/<username>, /products,
//      /products/p/<n>, plus /feed.rss and /drawings/<id>.gif assets.
//      These only appear once `npm run builder` (or the inline rebuild
//      hook in ingest/dev-server.ts) has written them.
//
//   2. Rewrite clean URLs for Vite-built entries (/merch, /merch/order/<id>,
//      /login, /signup, /reset, /account) to their backing *.html files so
//      Vite serves them. Doesn't read from disk — sets req.url and falls
//      through to Vite.

export interface DevBucketPluginOptions {
  bucketRoot?: string;
}

const SIXTY_FOUR_HEX = /^[0-9a-f]{64}$/;
const UUID_36 = /^[0-9a-f-]{36}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const POSITIVE_INT = /^\d+$/;

interface BuilderRoute {
  test: (uri: string) => string | null;
  contentType: string;
}

const MURAL_ID = /^mural-\d{4}-W\d{2}$/;

const BUILDER_ROUTES: BuilderRoute[] = [
  {
    test: (uri) => (uri === "/gallery" ? "gallery.html" : null),
    contentType: "text/html; charset=utf-8",
  },
  {
    test: (uri) => (uri === "/murals" ? "murals.html" : null),
    contentType: "text/html; charset=utf-8",
  },
  {
    test: (uri) => {
      const m = uri.match(/^\/murals\/([^/]+)$/);
      return m && MURAL_ID.test(m[1]) ? `murals/${m[1]}.html` : null;
    },
    contentType: "text/html; charset=utf-8",
  },
  {
    test: (uri) => (uri === "/products" ? "products.html" : null),
    contentType: "text/html; charset=utf-8",
  },
  {
    test: (uri) => (uri === "/feed.rss" ? "feed.rss" : null),
    contentType: "application/rss+xml; charset=utf-8",
  },
  {
    test: (uri) => {
      const m = uri.match(/^\/d\/([^/]+)$/);
      return m && SIXTY_FOUR_HEX.test(m[1]) ? `d/${m[1]}.html` : null;
    },
    contentType: "text/html; charset=utf-8",
  },
  {
    test: (uri) => {
      const m = uri.match(/^\/u\/([a-z0-9_-]{3,20})$/);
      return m ? `u/${m[1]}.html` : null;
    },
    contentType: "text/html; charset=utf-8",
  },
  {
    test: (uri) => {
      const m = uri.match(/^\/days\/([^/]+)\/p\/([^/]+)$/);
      return m && ISO_DATE.test(m[1]) && POSITIVE_INT.test(m[2])
        ? `days/${m[1]}/p/${m[2]}.html`
        : null;
    },
    contentType: "text/html; charset=utf-8",
  },
  {
    test: (uri) => {
      const m = uri.match(/^\/products\/p\/([^/]+)$/);
      return m && POSITIVE_INT.test(m[1]) ? `products/p/${m[1]}.html` : null;
    },
    contentType: "text/html; charset=utf-8",
  },
  {
    test: (uri) => {
      const m = uri.match(/^\/drawings\/([^/]+\.gif)$/);
      return m ? `drawings/${m[1]}` : null;
    },
    contentType: "image/gif",
  },
  // Canvas pages /c/<64hex> + their composite preview /c/<64hex>.png.
  {
    test: (uri) => {
      const m = uri.match(/^\/c\/([^/]+)$/);
      return m && SIXTY_FOUR_HEX.test(m[1]) ? `c/${m[1]}.html` : null;
    },
    contentType: "text/html; charset=utf-8",
  },
  {
    test: (uri) => {
      const m = uri.match(/^\/c\/([0-9a-f]{64}(?:-large)?\.png)$/);
      return m ? `c/${m[1]}` : null;
    },
    contentType: "image/png",
  },
  // Tile pages /t/<64hex> + tile assets /tiles/<64hex>.gif.
  {
    test: (uri) => {
      const m = uri.match(/^\/t\/([^/]+)$/);
      return m && SIXTY_FOUR_HEX.test(m[1]) ? `t/${m[1]}.html` : null;
    },
    contentType: "text/html; charset=utf-8",
  },
  {
    test: (uri) => {
      const m = uri.match(/^\/tiles\/([0-9a-f]{64}\.gif)$/);
      return m ? `tiles/${m[1]}` : null;
    },
    contentType: "image/gif",
  },
];

// Vite-entry clean URL → backing file in the project root. Matches the
// CloudFront rules so dev navigation behaves the same as prod.
function viteEntryRewrite(uri: string): string | null {
  if (uri === "/merch") return "/merch.html";
  if (uri === "/login") return "/login.html";
  if (uri === "/signup") return "/signup.html";
  if (uri === "/reset") return "/reset.html";
  if (uri === "/account") return "/account.html";
  if (uri === "/privacy") return "/privacy.html";
  if (UUID_36.test(uri.slice("/merch/order/".length)) && uri.startsWith("/merch/order/")) {
    return "/order.html";
  }
  return null;
}

// Anything that looks like a clean URL (no file extension) but matches no
// known route gets the chrome'd 404 page if the builder has produced one.
// Mirrors CloudFront's CustomErrorResponses → /404.html mapping. Asset
// requests (those with an extension) fall through to Vite so its own
// 404 handling still kicks in for dev-time bundle misses.
function looksLikeCleanUrl(uri: string): boolean {
  if (uri === "/" || uri === "") return false;
  const last = uri.split("/").pop() ?? "";
  return !last.includes(".");
}

export function devBucketPlugin(opts: DevBucketPluginOptions = {}): Plugin {
  const bucketRoot = path.resolve(opts.bucketRoot ?? "./dev-bucket");
  const publicRoot = path.join(bucketRoot, "public");
  return {
    name: "drawbang-dev-bucket",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        const [pathOnly, query = ""] = url.split("?", 2);

        // 1. Vite-entry clean URLs: rewrite + fall through to Vite.
        const entryRewrite = viteEntryRewrite(pathOnly);
        if (entryRewrite) {
          req.url = query ? `${entryRewrite}?${query}` : entryRewrite;
          return next();
        }

        // 2. Builder-rendered routes: read from dev-bucket/public/ if present.
        for (const route of BUILDER_ROUTES) {
          const rel = route.test(pathOnly);
          if (rel === null) continue;
          const filePath = path.join(publicRoot, rel);
          // Defense in depth: never escape the public root.
          if (!filePath.startsWith(publicRoot + path.sep) && filePath !== publicRoot) {
            res.statusCode = 400;
            res.end("bad path");
            return;
          }
          try {
            const body = await fs.readFile(filePath);
            res.setHeader("Content-Type", route.contentType);
            res.setHeader("Cache-Control", "no-store");
            res.end(body);
            return;
          } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === "ENOENT") {
              return serveNotFound(publicRoot, res, next, rel);
            }
            return next(err);
          }
        }

        // 3. Unmatched clean URLs (e.g. /murale typo, /404 itself) → /404.html.
        if (pathOnly === "/404" || looksLikeCleanUrl(pathOnly)) {
          return serveNotFound(publicRoot, res, next, pathOnly);
        }

        next();
      });
    },
  };
}

async function serveNotFound(
  publicRoot: string,
  res: import("node:http").ServerResponse,
  next: (err?: unknown) => void,
  requested: string,
): Promise<void> {
  try {
    const body = await fs.readFile(path.join(publicRoot, "404.html"));
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        `Not found: ${requested}\n\n` +
          `Run \`npm run builder\` to generate the 404 page.\n`,
      );
      return;
    }
    next(err);
  }
}
