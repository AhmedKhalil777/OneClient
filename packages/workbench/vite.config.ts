import { resolve } from "node:path";
import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The workbench UI: the shell (index.html) and core's views (file editor, terminal, diff). One build serves both
 * runtimes — the desktop app loads it from disk (core's electron-vite reuses this config), the web server over HTTP —
 * so every URL in it is relative (`base: "./"`).
 */
export function workbenchConfig(root: string, outDir = resolve(root, "dist")): UserConfig {
  return {
    root,
    base: "./",
    resolve: {
      alias: {
        // plugin-api is published as CommonJS (the backend needs that), and neither Vite's dev server nor Rollup runs
        // CJS interop on a symlinked workspace package: read its ESM TypeScript source instead.
        "@oneclient/plugin-api": resolve(root, "../plugin-api/src/index.ts"),
        // The backend's shared modules (the IPC contract, diff, git graph…) are bundled from source too.
        "@oneclient/backend/shared": resolve(root, "../backend/src/shared"),
      },
    },
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(root, "index.html"),
          // Core views: hosted like plugin views — the file editor, the terminal and the diff.
          editor: resolve(root, "views/editor/index.html"),
          terminal: resolve(root, "views/terminal/index.html"),
          diff: resolve(root, "views/diff/index.html"),
        },
      },
    },
    plugins: [react()],
  };
}

export default defineConfig(workbenchConfig(__dirname));
