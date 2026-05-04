import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: ".",
  publicDir: "static",
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
