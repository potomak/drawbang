import { defineConfig } from "vite";
import { resolve } from "node:path";
import basicSsl from "@vitejs/plugin-basic-ssl";
import tailwindcss from "@tailwindcss/vite";
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
  "^/$",
  "/admin",
  "/auth",
  "/backfill",
  "/design",
  "/v2/design",
  "/drawings",
  "/feed.rss",
  "/feed/items",
  "/hydrate",
  "/ingest",
  "/me",
  "/subscribe",
  "/users",
  "^/d/.*",
  "^/embed/.*",
  "^/gallery(/items)?$",
  "^/products.*",
  "^/prompts.*",
  "^/u/.*",
];

export default defineConfig({
  root: ".",
  publicDir: "static",
  // MPA mode: don't fall back to index.html for unmatched URLs (it's
  // gone — the editor lives at /draw now, and / is the dynamic feed
  // served by the ingest dev-server).
  appType: "mpa",
  plugins: [
    tailwindcss(),
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
        order: resolve(__dirname, "order.html"),
        login: resolve(__dirname, "login.html"),
        signup: resolve(__dirname, "signup.html"),
        "password-forgot": resolve(__dirname, "password-forgot.html"),
        "password-reset": resolve(__dirname, "password-reset.html"),
        account: resolve(__dirname, "account.html"),
        privacy: resolve(__dirname, "privacy.html"),
        "hydrate-v2-design": resolve(__dirname, "src/hydrate-v2-design.tsx"),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "hydrate-v2-design") return "assets/hydrate-v2-design.js";
          return "assets/[name]-[hash].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
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
