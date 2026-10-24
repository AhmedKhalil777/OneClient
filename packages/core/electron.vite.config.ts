import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { workbenchConfig } from "../workbench/vite.config";

const backendShared = resolve(__dirname, "../backend/src/shared");

export default defineConfig({
  main: {
    // @oneclient/backend stays external: required at runtime from its built dist (its helper processes —
    // extension host, terminal host, search worker — are files there too).
    build: { rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts") } } },
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    // Sandboxed preloads can't require packages: bundle the backend's shared IPC contract from source.
    resolve: { alias: { "@oneclient/backend/shared": backendShared } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          view: resolve(__dirname, "src/preload/view.ts"),
        },
      },
    },
    plugins: [externalizeDepsPlugin({ exclude: ["@oneclient/backend"] })],
  },
  // The UI is @oneclient/workbench (shared with the web server); built into out/renderer for the desktop app.
  renderer: workbenchConfig(resolve(__dirname, "../workbench"), resolve(__dirname, "out/renderer")),
});
