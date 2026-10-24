#!/usr/bin/env node
/**
 * Packages oneClient into installers with electron-builder.
 *
 *   node scripts/package.mjs              build everything, then installers for this OS (into release/)
 *   node scripts/package.mjs --dir        an unpacked app only (quick local check)
 *   node scripts/package.mjs --skip-build reuse the existing build output
 *
 * Env: ONECLIENT_VERSION=1.2.3 sets the app version (CI passes the tag without its "v").
 *
 * The workspace uses pnpm symlinks, which installers can't carry, so the app and every plugin are first staged as
 * standalone folders with only their production dependencies (`pnpm deploy`, hoisted = real directories):
 *
 *   staging/app/              core: out/ (main, preload, renderer, core views), resources/, node_modules/
 *   staging/plugins/<name>/   each bundled plugin: oneclient.json, dist/, assets, node_modules/
 *
 * electron-builder packs staging/app as the app and copies staging/plugins next to it (resources/plugins), where
 * core loads bundled plugins from in a packaged build.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const staging = join(root, "staging");
const isWin = process.platform === "win32";

function run(command, cwd = root) {
  console.log(`\n> ${command}`);
  const r = spawnSync(command, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error(`"${command}" failed (exit ${r.status}).`);
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);

/** `pnpm deploy`: the package plus its production dependencies, as real folders (no workspace symlinks). */
function deploy(pkgName, target) {
  run(`pnpm --filter "${pkgName}" deploy --prod --legacy --config.node-linker=hoisted "${target}"`);
}

/** Runtime files of a package, without sources, tests and build configs (deploy skips gitignored build output). */
const SKIP = new Set(["node_modules", "src", "src-ui", "test", "tests", "scripts", "tsconfig.json", "tsconfig.ui.json", "tsconfig.tsbuildinfo", "vite.config.ts", "vitest.config.ts", "electron.vite.config.ts"]);
function copyRuntime(from, to) {
  for (const entry of readdirSync(from)) {
    if (SKIP.has(entry) || entry.startsWith("tsconfig")) continue;
    cpSync(join(from, entry), join(to, entry), { recursive: true, force: true });
  }
}

// ---- 1. build ---------------------------------------------------------------------------------------------------------
if (!args.has("--skip-build")) run("pnpm run build");

// ---- 2. stage ---------------------------------------------------------------------------------------------------------
rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, "plugins"), { recursive: true });

const coreDir = join(root, "packages", "core");
const corePkg = readJson(join(coreDir, "package.json"));
const appDir = join(staging, "app");
deploy(corePkg.name, appDir);
for (const dir of ["out", "resources"]) cpSync(join(coreDir, dir), join(appDir, dir), { recursive: true, force: true });

const version = (process.env.ONECLIENT_VERSION || readJson(join(root, "package.json")).version).replace(/^v/, "");
const electronVersion = readJson(join(coreDir, "node_modules", "electron", "package.json")).version;
writeJson(join(appDir, "package.json"), {
  name: "oneclient",
  productName: "oneClient",
  version,
  description: "One client for everything — a plug-and-play desktop console for infrastructure tools.",
  author: { name: "Ahmed Khalil", email: "mj77777theking@gmail.com" },
  license: "MIT",
  homepage: "https://github.com/AhmedKhalil777/OneClient",
  main: "./out/main/index.js",
  dependencies: corePkg.dependencies,
});

const pluginsRoot = join(root, "packages", "plugins");
const bundled = [];
for (const dir of readdirSync(pluginsRoot)) {
  const src = join(pluginsRoot, dir);
  if (!existsSync(join(src, "oneclient.json")) || !existsSync(join(src, "package.json"))) continue;
  const pkg = readJson(join(src, "package.json"));
  const target = join(staging, "plugins", dir);
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) deploy(pkg.name, target);
  else mkdirSync(target, { recursive: true });
  copyRuntime(src, target);
  // UI-only libraries are already bundled into dist/ui; keep node_modules for what the plugin's main needs.
  bundled.push(`${dir}@${readJson(join(src, "oneclient.json")).version}`);
}
console.log(`\nStaged oneClient ${version} (Electron ${electronVersion}) with ${bundled.length} plugins: ${bundled.join(", ")}`);

// ---- 3. package -------------------------------------------------------------------------------------------------------
// electron-builder is a dev dependency of the desktop package (packages/core), so web-only installs never get it.
const { build } = await import(pathToFileURL(createRequire(join(coreDir, "package.json")).resolve("electron-builder")).href);
/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "dev.oneclient.app",
  productName: "oneClient",
  copyright: `Copyright © ${new Date().getFullYear()} Ahmed Khalil`,
  electronVersion,
  directories: { app: appDir, output: join(root, "release"), buildResources: join(coreDir, "resources") },
  files: ["**/*", "!**/*.map", "!**/{README,CHANGELOG}.md", "!**/{test,tests,__tests__}/**"],
  // Native modules (the terminal's node-pty) can't load from inside the asar archive.
  asarUnpack: ["**/node_modules/node-pty/**"],
  extraResources: [{ from: join(staging, "plugins"), to: "plugins", filter: ["**/*", "!**/*.map"] }],
  // node-pty ships N-API prebuilds that work in Electron; nothing to recompile.
  npmRebuild: false,
  artifactName: "oneClient-${version}-${os}-${arch}.${ext}",
  win: { target: [{ target: "nsis", arch: ["x64"] }, { target: "zip", arch: ["x64"] }], icon: join(coreDir, "resources", "icon-256.png") },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, shortcutName: "oneClient" },
  mac: { target: [{ target: "dmg", arch: ["x64", "arm64"] }, { target: "zip", arch: ["x64", "arm64"] }], category: "public.app-category.developer-tools", icon: join(coreDir, "resources", "icon.png"), identity: null },
  linux: { target: [{ target: "AppImage", arch: ["x64"] }, { target: "tar.gz", arch: ["x64"] }], category: "Development", icon: join(coreDir, "resources", "icon.png"), maintainer: "Ahmed Khalil <mj77777theking@gmail.com>" },
  publish: null,
};

const targets = args.has("--dir") ? { dir: true } : {};
await build({ config, publish: "never", ...(args.has("--dir") ? { dir: true } : {}), ...targets, ...(isWin ? { win: [] } : process.platform === "darwin" ? { mac: [] } : { linux: [] }) });
console.log(`\nDone: ${join(root, "release")}`);
