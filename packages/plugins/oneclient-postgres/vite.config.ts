import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tier 2 views are loaded via file://, so every asset path must be relative
// (base: "./"). Output sits next to dist/main.js, matching oneclient.json.
// Two pages: the query window (editor tab) and Query Results (bottom panel).
export default defineConfig({
  root: resolve(__dirname, "src-ui"),
  base: "./",
  plugins: [react()],
  // Shared workspace packages (e.g. @oneclient/editor-kit) must use this bundle's single React copy.
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    outDir: resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "src-ui/index.html"),
        results: resolve(__dirname, "src-ui/results.html"),
      },
    },
  },
});
