import { defineConfig } from "vite";
import { resolve } from "node:path";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { chromePlugin } from "./vite/plugins/chrome.js";
import { devBucketPlugin } from "./vite/plugins/dev-bucket.js";

// HTTPS in dev only — Web Crypto (the PoW SHA-256 fallback) needs a secure
// context, and plain http://<LAN-IP> isn't one. Plugin generates a
// self-signed cert on first start.
const enableHttps = process.env.VITE_HTTPS === "1";

export default defineConfig({
  root: ".",
  publicDir: "static",
  plugins: [
    chromePlugin({ repoUrl: process.env.VITE_REPO_URL }),
    devBucketPlugin(),
    ...(enableHttps ? [basicSsl()] : []),
  ],
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        "pow-test": resolve(__dirname, "pow-test.html"),
        merch: resolve(__dirname, "merch.html"),
        order: resolve(__dirname, "order.html"),
        login: resolve(__dirname, "login.html"),
        signup: resolve(__dirname, "signup.html"),
        reset: resolve(__dirname, "reset.html"),
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
    proxy: {
      "/ingest": "http://localhost:8787",
      "/auth": "http://localhost:8787",
      "/state/last-publish.json": "http://localhost:8787",
      "/state/current-canvas.json": "http://localhost:8787",
      // Singular `/canvas/*` is the API path (claim + state). The plural
      // `/canvases/...` static pages are handled by the dev-bucket plugin
      // — this regex avoids matching them.
      "^/canvas/.+": "http://localhost:8787",
    },
  },
});
