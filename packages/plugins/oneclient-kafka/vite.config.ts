import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tier 2 views are loaded via file://, so every asset path must be relative (base: "./").
// Three pages: the cluster overview, one tab per topic and one per consumer group.
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
        cluster: resolve(__dirname, "src-ui/cluster.html"),
        topic: resolve(__dirname, "src-ui/topic.html"),
        group: resolve(__dirname, "src-ui/group.html"),
      },
    },
  },
});
