import { defineConfig } from "vitest/config";

// The Vite config roots at src-ui for the UI build; tests live in ./test.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
