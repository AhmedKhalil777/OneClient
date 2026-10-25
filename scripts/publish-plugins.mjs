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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const only = argv.flatMap((a, i) => (a === "--only" ? [argv[i + 1]] : []));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const run = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: "inherit", ...opts });

const owner = (process.env.GITHUB_REPOSITORY_OWNER ?? execSync("git remote get-url origin", { cwd: root }).toString().match(/github\.com[:/]([^/]+)\//)?.[1] ?? "").toLowerCase();
if (!owner) throw new Error("Can't work out the GitHub owner (set GITHUB_REPOSITORY_OWNER).");
const registry = "https://npm.pkg.github.com";
const staging = join(root, "staging", "npm");

if (!argv.includes("--skip-build")) run("pnpm run build");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// Third-party dependencies of the inlined workspace libraries (e.g. sql-core → ssh2) are external too.
const libDeps = {};
for (const lib of ["plugin-api", "sql-core", "editor-kit"]) Object.assign(libDeps, readJson(join(root, "packages", lib, "package.json")).dependencies);
for (const d of Object.keys(libDeps)) if (d.startsWith("@oneclient/")) delete libDeps[d];

const pluginsRoot = join(root, "packages", "plugins");
const published = [];
for (const dir of readdirSync(pluginsRoot).sort()) {
  const src = join(pluginsRoot, dir);
  if (!existsSync(join(src, "oneclient.json")) || !existsSync(join(src, "package.json"))) continue;
  if (only.length && !only.includes(dir)) continue;

  const pkg = readJson(join(src, "package.json"));
  const manifest = readJson(join(src, "oneclient.json"));
  const name = `@${owner}/${dir}`;
  const target = join(staging, dir);
  mkdirSync(target, { recursive: true });
  console.log(`\n== ${name}@${manifest.version}`);

  // main: one file, workspace libraries inlined, everything else left as a runtime dependency.
  const result = await build({
    entryPoints: [join(src, "dist", "main.js")],
    outfile: join(target, "dist", "main.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["electron", "*.node", ...Object.keys({ ...libDeps, ...pkg.dependencies }).filter((d) => !d.startsWith("@oneclient/"))],
    metafile: true,
    logLevel: "warning",
  });
  const externals = new Set();
  for (const out of Object.values(result.metafile.outputs))
    for (const imp of out.imports) if (imp.external && !imp.path.startsWith("node:") && !imp.path.startsWith(".")) externals.add(imp.path.split("/").slice(0, imp.path.startsWith("@") ? 2 : 1).join("/"));
  const builtins = new Set(["electron", ...(await import("node:module")).builtinModules]);
  const dependencies = {};
  for (const d of [...externals].sort()) {
    if (builtins.has(d)) continue;
    const range = pkg.dependencies?.[d] ?? libDeps[d];
    if (!range) throw new Error(`${dir}: main.js imports "${d}", which isn't in its dependencies.`);
    dependencies[d] = range;
  }

  // Everything else the manifest points at: the UI bundle, icons, README.
  for (const rel of [manifest.ui, manifest.icon, "oneclient.json", "README.md", "LICENSE"]) {
    if (rel && existsSync(join(src, rel))) cpSync(join(src, rel), join(target, rel), { recursive: true });
  }
  if (!existsSync(join(target, "LICENSE"))) cpSync(join(root, "LICENSE"), join(target, "LICENSE"));
  for (const c of manifest.contributes?.icons ?? []) {
    if (c.path && existsSync(join(src, c.path))) cpSync(join(src, c.path), join(target, c.path), { recursive: true });
  }

  writeFileSync(
    join(target, "package.json"),
    JSON.stringify(
      {
        name,
        version: manifest.version,
        description: pkg.description ?? manifest.description,
        license: pkg.license ?? "MIT",
        keywords: ["oneclient", "oneclient-plugin"],
        main: manifest.main,
        files: ["dist", "oneclient.json", "README.md", "LICENSE", "*.svg", "*.png"],
        dependencies,
        repository: { type: "git", url: `git+https://github.com/${owner}/OneClient.git`, directory: `packages/plugins/${dir}` },
        publishConfig: { registry, access: "restricted" },
      },
      null,
      2,
    ) + "\n",
  );

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
