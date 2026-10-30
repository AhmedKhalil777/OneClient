#!/usr/bin/env node
/**
 * Publish the plugins to GitHub Packages (npm.pkg.github.com) as @<owner>/<plugin-dir>.
 *
 *   node scripts/publish-plugins.mjs --dry-run             build + stage + `npm pack` every plugin, publish nothing
 *   node scripts/publish-plugins.mjs                       publish every plugin (needs NODE_AUTH_TOKEN with write:packages)
 *   node scripts/publish-plugins.mjs --only oneclient-mysql [--only ...]
 *   node scripts/publish-plugins.mjs --skip-build          reuse the existing dist/ folders
 *
 * GitHub Packages only allows the scope of the repository owner, so the workspace libraries (@oneclient/plugin-api,
 * sql-core, editor-kit — not published) are bundled into each plugin's dist/main.js with esbuild. Third-party packages the
 * plugin's main really imports (mysql2, kafkajs, …) stay external and become the package's `dependencies`. The UI
 * (dist/ui) is already a self-contained Vite bundle. The version is the plugin's oneclient.json version; versions
 * already on the registry are skipped, so re-running is safe.
 */
import { execSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stagePlugins } from "./lib/stage-plugins.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const only = argv.flatMap((a, i) => (a === "--only" ? [argv[i + 1]] : []));
const run = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: "inherit", ...opts });

const owner = (process.env.GITHUB_REPOSITORY_OWNER ?? execSync("git remote get-url origin", { cwd: root }).toString().match(/github\.com[:/]([^/]+)\//)?.[1] ?? "").toLowerCase();
if (!owner) throw new Error("Can't work out the GitHub owner (set GITHUB_REPOSITORY_OWNER).");
const registry = "https://npm.pkg.github.com";
const staging = join(root, "staging", "npm");

if (!argv.includes("--skip-build")) run("pnpm run build");

const published = [];
for (const { dir, version, target } of await stagePlugins({ root, owner, staging, only })) {
  const name = `@${owner}/${dir}`;
  const manifest = { version };

  if (dryRun) {
    run("npm pack --dry-run", { cwd: target });
    continue;
  }
  const exists = spawnSync("npm", ["view", `${name}@${manifest.version}`, "version", "--registry", registry], { cwd: target, shell: true, encoding: "utf8" });
  if (exists.stdout?.trim()) {
    console.log(`already published — skipping`);
    continue;
  }
  run("npm publish", { cwd: target });
  published.push(`${name}@${manifest.version}`);
}
console.log(dryRun ? "\nDry run done." : `\nPublished ${published.length}: ${published.join(", ") || "(nothing new)"}`);
