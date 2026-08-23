import { defineConfig } from "vite";
import { resolve } from "node:path";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { chromePlugin } from "./vite/plugins/chrome.js";
import { devBucketPlugin } from "./vite/plugins/dev-bucket.js";

// HTTPS in dev only — Web Crypto needs a secure context, and plain
// http://<LAN-IP> isn't one. Plugin generates a self-signed cert on first
// start.
const enableHttps = process.env.VITE_HTTPS === "1";

// Paths the ingest dev-server owns (npm run ingest:dev on :8787), kept in
// one place because two things need them: vite's proxy, and the dev-bucket
// middleware — which runs AHEAD of the proxy and would otherwise answer a
// proxied GET with its clean-URL 404 page. That's not hypothetical: it's
// how GET /auth/challenge broke signup locally.
//
// Keys starting with ^ are regexes; the rest are prefix matches (vite's
// own proxy semantics).
const DEV_PROXY_TARGET = "http://localhost:8787";
const DEV_PROXY_PATHS = [
  "/ingest",
  "/auth",
  // Covers the /admin shell, /admin/data, and DELETE /admin/users/*.
  "/admin",
  // Dynamic-site routes that match what the prod Lambda serves: the
  // ingest dev-server renders them off MemoryDrawingStore so the
  // editor's "publish → see on the feed" loop works locally.
  // ^/$ matches just `/` (the feed home) — vite proxy keys starting
  // with ^ are regex, prefix keys would also match other paths.
  "^/$",
  "/feed.rss",
  "/feed/items",
  "^/gallery(/items)?$",
  "^/d/.*",
  "^/embed/.*",
  "^/u/.*",
  "^/prompts.*",
  "^/drawings/.*/like$",
  "/me/likes",
  "/likes/counts",
  "/subscribe",
  // Merch product pages — SSR via ingest dev-server (renderProductPageHandler)
  "/products",
  "^/merch/.*",
  "/hydrate",
];

export default defineConfig({
  root: ".",
  publicDir: "static",
  // MPA mode: don't fall back to index.html for unmatched URLs (it's
  // gone — the editor lives at /draw now, and / is the dynamic feed
  // served by the ingest dev-server).
  appType: "mpa",
  plugins: [
    chromePlugin({ repoUrl: process.env.VITE_REPO_URL }),
    devBucketPlugin({ proxiedPaths: DEV_PROXY_PATHS }),
    ...(enableHttps ? [basicSsl()] : []),
  ],
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      input: {
        draw: resolve(__dirname, "draw.html"),
        merch: resolve(__dirname, "merch.html"),
        product: resolve(__dirname, "product.html"),
        order: resolve(__dirname, "order.html"),
        login: resolve(__dirname, "login.html"),
        signup: resolve(__dirname, "signup.html"),
        "password-forgot": resolve(__dirname, "password-forgot.html"),
        "password-reset": resolve(__dirname, "password-reset.html"),
        account: resolve(__dirname, "account.html"),
        privacy: resolve(__dirname, "privacy.html"),
      },
    },
  },
  worker: {
    format: "es",
  },
  server: {
    port: 5173,
    // Forward ingest + last-publish state to the local ingest dev server
    // (npm run ingest:dev on :8787) so the editor stays on a single origin
    // and uses its default relative URLs. Mirrors the prod CloudFront
    // setup where everything appears under one hostname.
    proxy: Object.fromEntries(DEV_PROXY_PATHS.map((p) => [p, DEV_PROXY_TARGET])),
  },
});
