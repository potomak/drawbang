import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  publicDir: "static",
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  worker: {
    format: "es",
  },
  server: {
    port: 5173,
  },
});
