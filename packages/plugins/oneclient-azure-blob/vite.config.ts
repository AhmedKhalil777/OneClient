import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tier 2 views are loaded via file://, so every asset path must be relative (base: "./").
// Two pages: the blob view (one tab per blob) and the container browser.
export default defineConfig({
  root: resolve(__dirname, "src-ui"),
  base: "./",
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: { "@oneclient/plugin-api": resolve(__dirname, "../../plugin-api/src/index.ts") },
  },
  build: {
    outDir: resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        blob: resolve(__dirname, "src-ui/blob.html"),
        browser: resolve(__dirname, "src-ui/browser.html"),
      },
    },
  },
});
