import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tier 2 views are loaded via file://, so every asset path must be relative
// (base: "./"). Output sits next to dist/main.js, matching oneclient.json.
export default defineConfig({
  root: resolve(__dirname, "src-ui"),
  base: "./",
  plugins: [react()],
  // Shared workspace packages (e.g. @oneclient/editor-kit) must use this bundle's single React copy.
  resolve: {
    dedupe: ["react", "react-dom"],
    // plugin-api ships as CommonJS; read its ESM source so the UI can use its small runtime helpers (matchFileEditors, …).
    alias: { "@oneclient/plugin-api": resolve(__dirname, "../../plugin-api/src/index.ts") },
  },
  build: {
    outDir: resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
  },
});
