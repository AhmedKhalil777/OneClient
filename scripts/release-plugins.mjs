#!/usr/bin/env node
/**
 * Releases the plugins whose version changed, and records every release in plugin.json — the catalog the app reads.
 *
 *   node scripts/release-plugins.mjs --dry-run         build + pack every plugin, change nothing
 *   node scripts/release-plugins.mjs                   for each plugin whose version has no release yet: create the GitHub Release
 *                                                      `<plugin>-v<version>` with `<plugin>-<version>.tgz` attached, then update plugin.json
 *   node scripts/release-plugins.mjs --only oneclient-mysql [--only ...]
 *   node scripts/release-plugins.mjs --skip-build      reuse the existing dist/ folders
 *
 * Needs the GitHub CLI (`gh`) with a token that can write releases (GH_TOKEN in Actions). plugin.json is rewritten, not
 * committed: the workflow (or you) commits it. Releases that already exist are never touched, so re-running is safe.
 *
 * plugin.json says, for every plugin, which versions exist and which app each one supports:
 *   app     semver range of oneClient versions it runs on — "oneclient": { "app": ">=0.1.0" } in the plugin's package.json
 *           (default: ">=" the app version in the root package.json when the plugin was released)
 *   engine  the plugin-API range from oneclient.json (engines.oneclient)
 *   url / sha512 / size   the release asset; the app refuses a download that doesn't match the checksum
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, stagePlugins } from "./lib/stage-plugins.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const only = argv.flatMap((a, i) => (a === "--only" ? [argv[i + 1]] : []));
const catalogPath = join(root, "plugin.json");

const remote = () => execFileSync("git", ["remote", "get-url", "origin"], { cwd: root }).toString().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\s*$/)?.[1];
const repo = process.env.GITHUB_REPOSITORY ?? remote();
if (!repo) throw new Error("Can't work out the GitHub repository (set GITHUB_REPOSITORY).");
const owner = repo.split("/")[0].toLowerCase();
const appVersion = readJson(join(root, "package.json")).version;

const gh = (args, opts = {}) => spawnSync("gh", args, { cwd: root, encoding: "utf8", ...opts });
const releaseExists = (tag) => gh(["release", "view", tag, "--repo", repo]).status === 0;

/** Newest first. Only the numeric part is compared — plugin versions are plain x.y.z. */
const byVersionDesc = (a, b) => {
  const n = (v) => v.split("-")[0].split(".").map(Number);
  const [x, y] = [n(a.version), n(b.version)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

const catalog = existsSync(catalogPath) ? readJson(catalogPath) : { schema: 1, plugins: {} };
catalog.schema = 1;
catalog.plugins ??= {};

if (!argv.includes("--skip-build")) execFileSync("pnpm", ["run", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

const staging = join(root, "staging", "release");
const assets = join(staging, "assets");
const staged = await stagePlugins({ root, owner, staging: join(staging, "pkg"), only });
mkdirSync(assets, { recursive: true });

const released = [];
for (const { dir, version, target, manifest, pkg } of staged) {
  const tag = `${dir}-v${version}`;
  const asset = `${dir}-${version}.tgz`;
  const entry = (catalog.plugins[dir] ??= { releases: [] });
  const known = entry.releases.find((r) => r.version === version);
  entry.description = manifest.description ?? pkg.description ?? entry.description;
  if (known && (dryRun || releaseExists(tag))) {
    console.log(`${tag}: already released — skipping`);
    continue;
  }

  // npm pack makes the same tarball `npm publish` would (a `package/` folder inside) — the app's extractor expects that.
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", assets], { cwd: target, shell: process.platform === "win32" }).toString())[0].filename;
  rmSync(join(assets, asset), { force: true });
  renameSync(join(assets, packed), join(assets, asset));
  let archive = readFileSync(join(assets, asset));

  if (dryRun) {
    console.log(`${tag}: would release ${asset} (${archive.length} bytes)`);
    continue;
  }
  if (releaseExists(tag)) {
    // Released earlier but never recorded (the run stopped in between): the catalog must describe what is really attached.
    const got = gh(["release", "download", tag, "--repo", repo, "--pattern", asset, "--dir", assets, "--clobber"]);
    if (got.status !== 0) throw new Error(`${tag} exists but its ${asset} can't be downloaded: ${got.stderr}`);
    archive = readFileSync(join(assets, asset));
  } else {
    const created = gh(
      ["release", "create", tag, join(assets, asset), "--repo", repo, "--title", `${dir} ${version}`, "--latest=false", "--notes", `Plugin \`${dir}\` ${version}. Install it from oneClient's Plugins view — it is listed in [plugin.json](https://github.com/${repo}/blob/main/plugin.json).`, ...(process.env.GITHUB_SHA ? ["--target", process.env.GITHUB_SHA] : [])],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (created.status !== 0) throw new Error(`Creating the release ${tag} failed.`);
  }

  const release = {
    version,
    app: pkg.oneclient?.app ?? `>=${appVersion}`,
    engine: manifest.engines?.oneclient ?? "*",
    url: `https://github.com/${repo}/releases/download/${tag}/${asset}`,
    sha512: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    size: archive.length,
    publishedAt: new Date().toISOString(),
  };
  entry.releases = [...entry.releases.filter((r) => r.version !== version), release].sort(byVersionDesc);
  released.push(tag);
  // Saved after every release: if a later one fails, the ones already out are still recorded.
  writeCatalog();
}

function writeCatalog() {
  catalog.app = { version: appVersion };
  catalog.plugins = Object.fromEntries(Object.entries(catalog.plugins).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
}
if (!dryRun) writeCatalog();
console.log(dryRun ? "\nDry run done." : `\nReleased ${released.length}: ${released.join(", ") || "(nothing new)"}`);
