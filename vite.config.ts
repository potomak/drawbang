import { defineConfig } from "vite";
import { resolve } from "node:path";
import { chromePlugin } from "./vite/plugins/chrome.js";

export default defineConfig({
  root: ".",
  publicDir: "static",
  plugins: [
    chromePlugin({ repoUrl: process.env.VITE_REPO_URL }),
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
        share: resolve(__dirname, "share.html"),
        identity: resolve(__dirname, "identity.html"),
      },
    },
  },
  worker: {
    format: "es",
  },
  server: {
    port: 5173,
  },
});
