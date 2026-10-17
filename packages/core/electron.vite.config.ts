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
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
    plugins: [react()],
  },
});
