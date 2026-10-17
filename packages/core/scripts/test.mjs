// Runs vitest under Electron's own Node runtime (ELECTRON_RUN_AS_NODE=1)
// instead of the system Node used to run this script. Necessary because
// better-sqlite3 is rebuilt against Electron's ABI (see rebuild-native in
// package.json) — under plain system Node it fails with a
// NODE_MODULE_VERSION mismatch. Spawning via Node's child_process (rather
// than relying on shell env-var syntax, e.g. `VAR=x cmd`) keeps this
// script identical on Windows/macOS/Linux.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const vitestEntry = require.resolve("vitest/vitest.mjs");

const result = spawnSync(electronBinary, [vitestEntry, "run", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});

process.exit(result.status ?? 1);
