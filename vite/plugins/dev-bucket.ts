import type { Plugin } from "vite";
import { promises as fs } from "node:fs";
import path from "node:path";

// Dev-only middleware that mirrors the prod CloudFront Function (see
// infra/aws/template.yaml RewriteCleanUrls) so clean URLs work against the
// Vite dev server. Two responsibilities:
//
//   1. Serve builder-rendered HTML from ./dev-bucket/public/<...>.html for
//      /gallery, /d/<id>, /days/<date>/p/<n>, /keys/<pk>, /products,
//      /products/p/<n>, plus /feed.rss and /drawings/<id>.gif assets.
//      These only appear once `npm run builder` (or the inline rebuild
//      hook in ingest/dev-server.ts) has written them.
//
//   2. Rewrite clean URLs for Vite-built entries (/merch, /merch/order/<id>,
//      /share, /identity) to their backing *.html files so Vite serves them.
//      Doesn't read from disk — sets req.url and falls through to Vite.

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

const BUILDER_ROUTES: BuilderRoute[] = [
  {
    test: (uri) => (uri === "/gallery" ? "gallery.html" : null),
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
      const m = uri.match(/^\/keys\/([^/]+)$/);
      return m && SIXTY_FOUR_HEX.test(m[1]) ? `keys/${m[1]}.html` : null;
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
];

// Vite-entry clean URL → backing file in the project root. Matches the
// CloudFront rules so dev navigation behaves the same as prod.
function viteEntryRewrite(uri: string): string | null {
  if (uri === "/merch") return "/merch.html";
  if (uri === "/share") return "/share.html";
  if (uri === "/identity") return "/identity.html";
  if (UUID_36.test(uri.slice("/merch/order/".length)) && uri.startsWith("/merch/order/")) {
    return "/order.html";
  }
  return null;
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
              res.statusCode = 404;
              res.setHeader("Content-Type", "text/plain; charset=utf-8");
              res.end(
                `Not found in dev-bucket: ${rel}\n\n` +
                  `Publish a drawing or run \`npm run builder\` to generate this page.\n`,
              );
              return;
            }
            return next(err);
          }
        }

        next();
      });
    },
  };
}
