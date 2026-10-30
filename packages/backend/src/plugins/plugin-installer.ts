import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { PLUGIN_API_VERSION } from "@oneclient/plugin-api";
import type { AvailablePlugin, PluginRegistryInfo, PluginSummary } from "../shared/types.js";
import type { FileSecretStore } from "../secrets/secret-store.js";
import { type Catalog, type CatalogRelease, compatibleReleases, parseCatalog } from "./plugin-catalog.js";
import { type PluginManager, summarizePlugin } from "./plugin-manager.js";

/** The GitHub account and repository the plugins live in (packages/plugins/<id>, releases, and the plugin.json catalog). */
export const DEFAULT_PLUGIN_OWNER = "ahmedkhalil777";
export const DEFAULT_PLUGIN_REPO = "OneClient";
export const DEFAULT_PLUGIN_REF = "main";
/** Secret-store key of an optional GitHub token — only for a private repository or to lift GitHub's anonymous rate limit. */
export const REGISTRY_TOKEN_KEY = "core:registry-token";

const PLUGIN_PREFIX = "oneclient-";
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const CATALOG_MAX_AGE_MS = 30_000;

export interface PluginInstallerOptions {
  /** The user plugins folder: every installed plugin is one subfolder of it. */
  userDir: string;
  pluginManager: PluginManager;
  secrets: FileSecretStore;
  /** Stops the plugin's extension host before its folder is replaced or deleted. */
  deactivate: (pluginId: string) => Promise<void>;
  /** This oneClient's version: only plugin releases that list it in their `app` range are offered. */
  appVersion: string;
  owner?: string;
  /** Where plugin.json is read from; defaults to the repository's main branch (or ONECLIENT_PLUGIN_CATALOG_URL). */
  catalogUrl?: string;
  /** Installs a plugin's runtime dependencies (`npm install --omit=dev`); injectable for tests. */
  installDependencies?: (dir: string) => Promise<void>;
  fetch?: typeof fetch;
}

/**
 * Installs plugins from GitHub Releases and removes them again, live — no restart. plugin.json (in the repository) lists
 * every released version of every plugin with the app versions it supports; the newest one that supports this app is
 * downloaded from its release, its checksum verified, extracted into the user plugins folder, its dependencies installed,
 * and then handed to the PluginManager like any plugin found at start-up. The manifest check (schema, engines.oneclient)
 * happens on that load; a plugin that fails it is taken out again.
 */
export class PluginInstaller {
  private readonly owner: string;
  private readonly catalogUrl: string;
  private readonly doFetch: typeof fetch;
  private busy: Promise<unknown> = Promise.resolve();
  private cached: { at: number; catalog: Catalog } | undefined;

  constructor(private readonly opts: PluginInstallerOptions) {
    this.owner = (opts.owner ?? process.env["ONECLIENT_PLUGIN_OWNER"] ?? DEFAULT_PLUGIN_OWNER).toLowerCase().replace(/^@/, "");
    this.catalogUrl = opts.catalogUrl ?? process.env["ONECLIENT_PLUGIN_CATALOG_URL"] ?? `https://raw.githubusercontent.com/${this.owner}/${DEFAULT_PLUGIN_REPO}/${DEFAULT_PLUGIN_REF}/plugin.json`;
    this.doFetch = opts.fetch ?? fetch;
  }

  async info(): Promise<PluginRegistryInfo> {
    return { scope: `${this.owner}/${DEFAULT_PLUGIN_REPO}`, url: this.catalogUrl, hasToken: Boolean(await this.token()), appVersion: this.opts.appVersion };
  }

  async setToken(token: string): Promise<void> {
    const trimmed = token.trim();
    if (trimmed) await this.opts.secrets.set(REGISTRY_TOKEN_KEY, trimmed);
    else await this.opts.secrets.delete(REGISTRY_TOKEN_KEY);
    this.cached = undefined;
  }

  /** The plugins that have a release for this oneClient, with their compatible versions (newest first). Always asks GitHub again. */
  async listAvailable(): Promise<AvailablePlugin[]> {
    const catalog = await this.catalog(0);
    const found: AvailablePlugin[] = [];
    for (const [id, plugin] of Object.entries(catalog.plugins)) {
      if (!id.startsWith(PLUGIN_PREFIX)) continue;
      const releases = compatibleReleases(plugin, this.opts.appVersion, PLUGIN_API_VERSION);
      if (releases.length > 0) found.push({ id, ...(plugin.description ? { description: plugin.description } : {}), latest: releases[0]!.version, versions: releases.map((r) => r.version) });
    }
    return found.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The plugin's README.md straight from its GitHub repository (the token is used when there is one, so private repos work). */
  async githubReadme(id: string): Promise<{ markdown: string; url: string } | undefined> {
    if (!ID_PATTERN.test(id)) return undefined;
    const path = `packages/plugins/${id}/README.md`;
    const headers: Record<string, string> = { Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "oneClient" };
    const token = await this.token();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    try {
      const res = await this.doFetch(`https://api.github.com/repos/${this.owner}/${DEFAULT_PLUGIN_REPO}/contents/${path}?ref=${DEFAULT_PLUGIN_REF}`, { headers });
      if (!res.ok) return undefined;
      return { markdown: await res.text(), url: `https://github.com/${this.owner}/${DEFAULT_PLUGIN_REPO}/blob/${DEFAULT_PLUGIN_REF}/${path}` };
    } catch {
      return undefined; // offline, rate limited… — the page falls back to the installed README
    }
  }

  /** What the catalog knows about one plugin — for the page of a plugin that isn't installed (or its newest version). */
  async remoteInfo(id: string): Promise<{ description?: string; readme?: string; latest?: string; license?: string }> {
    if (!ID_PATTERN.test(id)) throw new Error(`"${id}" is not a plugin name.`);
    const plugin = (await this.catalog(CATALOG_MAX_AGE_MS)).plugins[id];
    if (!plugin) throw new Error(`"${id}" is not in the plugin catalog.`);
    const latest = compatibleReleases(plugin, this.opts.appVersion, PLUGIN_API_VERSION)[0]?.version;
    if (!latest) throw new Error(`${id} has no version for oneClient ${this.opts.appVersion}${plugin.releases[0] ? ` (the newest, ${plugin.releases[0].version}, needs oneClient ${plugin.releases[0].app})` : ""}.`);
    return { ...(plugin.description ? { description: plugin.description } : {}), latest };
  }

  /** Installs `id` (or replaces the installed copy with) `version` — the newest one that supports this oneClient when omitted. */
  install(id: string, version?: string): Promise<PluginSummary> {
    return this.exclusive(() => this.doInstall(id, version));
  }

  uninstall(pluginId: string): Promise<void> {
    return this.exclusive(() => this.doUninstall(pluginId));
  }

  /** One install / uninstall at a time: they share the plugins folder and (for npm) a lock. */
  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.busy.then(job, job);
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async doInstall(id: string, requested?: string): Promise<PluginSummary> {
    if (!ID_PATTERN.test(id) || !id.startsWith(PLUGIN_PREFIX)) throw new Error(`"${id}" is not a plugin name.`);
    const plugin = (await this.catalog(CATALOG_MAX_AGE_MS)).plugins[id];
    if (!plugin) throw new Error(`${id} is not in the plugin catalog.`);
    const compatible = compatibleReleases(plugin, this.opts.appVersion, PLUGIN_API_VERSION);
    const release: CatalogRelease | undefined = requested ? compatible.find((r) => r.version === requested) : compatible[0];
    if (!release) {
      const any = requested ? plugin.releases.find((r) => r.version === requested) : plugin.releases[0];
      throw new Error(any ? `${id}@${any.version} needs oneClient ${any.app} (this is ${this.opts.appVersion}).` : `${id}${requested ? `@${requested}` : ""} has no release.`);
    }
    const version = release.version;

    const archive = await this.download(release.url);
    verifyChecksum(archive, release.sha512, `${id}@${version}`);

    const { userDir, pluginManager } = this.opts;
    await mkdir(userDir, { recursive: true });
    const staging = join(userDir, `.installing-${id}`);
    await rm(staging, { recursive: true, force: true });
    let target: string | undefined;
    let added = false;
    try {
      await extractTarball(archive, staging);
      const manifest = await readManifestName(staging);
      if (manifest !== id) throw new Error(`${id}@${version} contains the plugin "${manifest}", not "${id}".`);

      const existing = pluginManager.getRecord(id);
      if (existing && !existing.removable) throw new Error(`"${id}" is bundled with this app; the installed copy can't be replaced.`);
      if (existing) await this.doUninstall(id);

      target = join(userDir, id);
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
      await (this.opts.installDependencies ?? installDependencies)(target);

      added = true;
      const record = await pluginManager.add(target);
      if (!record || record.id !== id) throw new Error(`${id}@${version} has no valid oneclient.json.`);
      if (record.state === "invalid" || record.state === "incompatible") throw new Error(record.error ?? `${id}@${version} can't be loaded.`);
      return summarizePlugin(record);
    } catch (err) {
      if (added) {
        await this.opts.deactivate(id).catch(() => undefined);
        pluginManager.remove(id);
      }
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (target) await rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async doUninstall(pluginId: string): Promise<void> {
    const { pluginManager, userDir, deactivate } = this.opts;
    const record = pluginManager.getRecord(pluginId);
    if (!record) throw new Error(`Unknown plugin "${pluginId}".`);
    // Only what this installer put in the user folder is removed — never a bundled plugin or a development checkout.
    const root = resolve(record.rootDir);
    if (!record.removable || dirname(root) !== resolve(userDir)) throw new Error(`"${pluginId}" is bundled with this app and can't be uninstalled; disable it instead.`);
    await deactivate(pluginId);
    pluginManager.remove(pluginId);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }

  private async token(): Promise<string | undefined> {
    return (await this.opts.secrets.get(REGISTRY_TOKEN_KEY)) ?? (process.env["GITHUB_TOKEN"] || undefined);
  }

  /** plugin.json from the repository; a copy younger than `maxAgeMs` is reused. */
  private async catalog(maxAgeMs: number): Promise<Catalog> {
    if (this.cached && Date.now() - this.cached.at < maxAgeMs) return this.cached.catalog;
    const token = await this.token();
    let res: Response;
    try {
      res = await this.doFetch(this.catalogUrl, { headers: { Accept: "application/json", "User-Agent": "oneClient", "Cache-Control": "no-cache", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    } catch (err) {
      throw new Error(`Couldn't reach the plugin catalog (${new URL(this.catalogUrl).host}): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 404) throw new Error("The plugin catalog (plugin.json) wasn't found. If the repository is private, add a GitHub token.");
    if (res.status === 401 || res.status === 403) throw new Error("GitHub refused the request. Add a GitHub token (read access to the repository) or try again later.");
    if (!res.ok) throw new Error(`${new URL(this.catalogUrl).host} answered ${res.status} ${res.statusText} for the plugin catalog.`);
    const catalog = parseCatalog(await res.json().catch(() => null));
    this.cached = { at: Date.now(), catalog };
    return catalog;
  }

  private async download(url: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await this.doFetch(url, { headers: { Accept: "application/octet-stream", "User-Agent": "oneClient" }, redirect: "follow" });
    } catch (err) {
      throw new Error(`Couldn't download the plugin (${new URL(url).host}): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status} ${res.statusText} for ${new URL(url).pathname}.`);
    return Buffer.from(await res.arrayBuffer());
  }
}

function verifyChecksum(data: Buffer, sri: string, what: string): void {
  const [algorithm, expected] = sri.split("-", 2);
  if (!algorithm || !expected || createHash(algorithm).update(data).digest("base64") !== expected) throw new Error(`${what}: the download doesn't match its checksum.`);
}

async function readManifestName(dir: string): Promise<string> {
  let name: unknown;
  try {
    name = (JSON.parse(await readFile(join(dir, "oneclient.json"), "utf-8")) as { name?: unknown }).name;
  } catch {
    throw new Error("The package has no readable oneclient.json.");
  }
  if (typeof name !== "string" || !ID_PATTERN.test(name)) throw new Error("The package's oneclient.json has no valid plugin name.");
  return name;
}

const cString = (buf: Buffer, start: number, length: number): string => {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString("utf-8");
};

/** Extracts an npm tarball (gzip'd tar whose files sit under one top folder, usually `package/`) into `dest`. */
export async function extractTarball(archive: Buffer, dest: string): Promise<void> {
  const tar = gunzipSync(archive);
  const root = resolve(dest);
  let paxPath: string | undefined;
  let offset = 0;
  let files = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(cString(header, 124, 12).trim() || "0", 8);
    const type = header[156] ? String.fromCharCode(header[156]) : "0";
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === "x") {
      // pax extended header: "<len> path=<value>\n" records; only long paths matter here.
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf-8"))?.[1];
      continue;
    }
    if (type === "g") continue;
    const prefix = cString(header, 345, 155);
    let name = paxPath ?? (prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100));
    paxPath = undefined;
    if (type !== "0") continue; // directories are created by their files; links and devices are never needed

    const parts = name.split("/").filter(Boolean).slice(1); // drop the top folder
    name = parts.join("/");
    if (!name) continue;
    const file = resolve(root, ...parts);
    if (parts.includes("..") || file !== root && !file.startsWith(root + sep)) throw new Error(`The package contains an unsafe path: ${name}`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
    files++;
  }
  if (files === 0) throw new Error("The package is empty.");
}

/** Installs the plugin's third-party runtime dependencies next to its main.js (the bundle leaves them external). */
async function installDependencies(dir: string): Promise<void> {
  let deps: Record<string, string> = {};
  try {
    deps = (JSON.parse(await readFile(join(dir, "package.json"), "utf-8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
  } catch {
    return;
  }
  if (Object.keys(deps).length === 0 || existsSync(join(dir, "node_modules")) && (await readdir(join(dir, "node_modules"))).length > 0) return;
  await new Promise<void>((done, fail) => {
    // --ignore-scripts: a plugin's dependencies don't get to run install scripts on the user's machine.
    const child = spawn("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--registry", "https://registry.npmjs.org/"], { cwd: dir, shell: process.platform === "win32", stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => fail(new Error(`Couldn't run npm to install the plugin's dependencies (is Node.js / npm installed?): ${err.message}`)));
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`npm install failed (exit ${code}): ${stderr.trim().split("\n").slice(-4).join(" ")}`))));
  });
}
