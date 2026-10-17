import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose `root` is the UI folder (tests live in ./test).
export default defineConfig({
  resolve: { alias: { "@oneclient/plugin-api": resolve(__dirname, "../../plugin-api/src/index.ts") } },
  test: { include: ["test/**/*.test.ts"] },
});
