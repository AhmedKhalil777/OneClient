import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "extension-host": resolve(__dirname, "src/extension-host/bootstrap.ts"),
          // Core's own background processes: the integrated terminal and the workspace text search.
          "terminal-host": resolve(__dirname, "src/terminal-host/host.ts"),
          "search-worker": resolve(__dirname, "src/main/workspace/search-worker.ts"),
        },
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          view: resolve(__dirname, "src/preload/view.ts"),
        },
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: "src/renderer",
    resolve: {
      // plugin-api is published as CommonJS (the main process needs that), and neither Vite's dev server
      // nor Rollup runs CJS interop on a symlinked workspace package. Read its ESM TypeScript source
      // directly so the renderer can import its small runtime helpers (resolveFileIcon, colorVarName, …).
      alias: { "@oneclient/plugin-api": resolve(__dirname, "../plugin-api/src/index.ts") },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          // Core views: hosted like plugin views (sandboxed, with the view preload) — the file editor and the terminal.
          editor: resolve(__dirname, "src/renderer/views/editor/index.html"),
          terminal: resolve(__dirname, "src/renderer/views/terminal/index.html"),
        },
      },
    },
    plugins: [react()],
  },
});
