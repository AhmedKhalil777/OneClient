import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tier 2 views are loaded via file://, not served from an origin — every
// asset path must be relative, hence base: "./". Output goes to dist/ui to
// sit alongside dist/main.js (the Node side), matching oneclient.json's
// "main": "dist/main.js" / "ui": "dist/ui".
export default defineConfig({
  root: resolve(__dirname, "src-ui"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
  },
});
