import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tier 2 views are loaded via file://, so every asset path must be relative (base: "./").
// Four pages, one per view: JSON resource editor, list/table view, access (role mappings) and developer tools.
export default defineConfig({
  root: resolve(__dirname, "src-ui"),
  base: "./",
  plugins: [react()],
  resolve: {
    // Shared workspace packages (editor-kit) must use this bundle's single React copy…
    dedupe: ["react", "react-dom"],
    // …and plugin-api ships as CommonJS, so read its ESM source for the helpers editor-kit uses at runtime.
    alias: { "@oneclient/plugin-api": resolve(__dirname, "../../plugin-api/src/index.ts") },
  },
  build: {
    outDir: resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        resource: resolve(__dirname, "src-ui/resource.html"),
        table: resolve(__dirname, "src-ui/table.html"),
        mappings: resolve(__dirname, "src-ui/mappings.html"),
        tools: resolve(__dirname, "src-ui/tools.html"),
      },
    },
  },
});
