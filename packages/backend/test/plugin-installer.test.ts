import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../src/config/config-store.js";
import { PluginMetadataStore } from "../src/db/plugin-metadata-store.js";
import { PluginInstaller, extractTarball } from "../src/plugins/plugin-installer.js";
import { PluginManager } from "../src/plugins/plugin-manager.js";
import { ContributionRegistry } from "../src/plugins/registry.js";
import type { FileSecretStore } from "../src/secrets/secret-store.js";

/** A minimal ustar writer: enough to build the tarballs npm produces (everything under `package/`). */
function tarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    header.write("ustar\0" + "00", 257);
    header.fill(" ", 148, 156);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const manifest = (name: string, engine = "^0.1.0") => JSON.stringify({ name, version: "1.2.3", engines: { oneclient: engine }, contributes: {} });
const integrity = (data: Buffer) => `sha512-${createHash("sha512").update(data).digest("base64")}`;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "oneclient-installer-"));
  vi.stubEnv("NODE_AUTH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const CATALOG_URL = "https://plugins.test/plugin.json";
const releaseUrl = (id: string, version = "1.2.3") => `https://github.com/acme/OneClient/releases/download/${id}-v${version}/${id}-${version}.tgz`;

/** `packages` maps a plugin id to its tarball; each is released as 1.2.3 for oneClient >=0.1.0 and `extra` adds other releases. */
function setup(packages: Record<string, Buffer>, opts: { token?: string | null; appVersion?: string; extra?: Record<string, object[]> } = {}) {
  const { token = null, appVersion = "0.1.0", extra = {} } = opts;
  const userDir = join(home, "plugins");
  const pluginManager = new PluginManager([userDir], new ContributionRegistry(), new PluginMetadataStore(new ConfigStore(join(home, "cfg"))));
  const store = new Map<string, string>(token ? [["core:registry-token", token]] : []);
  const secrets = { get: async (k: string) => store.get(k), set: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) } as unknown as FileSecretStore;
  const requests: Array<{ url: string; auth: string | undefined }> = [];
  const catalog = () => ({
    schema: 1,
    plugins: Object.fromEntries(
      [...new Set([...Object.keys(packages), ...Object.keys(extra)])].map((id) => [
        id,
        {
          description: `${id} plugin`,
          releases: [...(extra[id] ?? []), ...(packages[id] ? [{ version: "1.2.3", app: ">=0.1.0", engine: "^0.1.0", url: releaseUrl(id), sha512: integrity(packages[id]!), size: packages[id]!.length }] : [])],
        },
      ]),
    ),
  });
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.["Authorization"] });
    if (url === CATALOG_URL) return Response.json(catalog());
    const download = /releases\/download\/([^/]+)-v[^/]+\/[^/]+\.tgz$/.exec(url)?.[1];
    if (download && packages[download]) return new Response(new Uint8Array(packages[download]!));
    return new Response("nope", { status: 404, statusText: "Not Found" });
  }) as typeof fetch;
  const deactivated: string[] = [];
  const installer = new PluginInstaller({ userDir, pluginManager, secrets, deactivate: async (id) => void deactivated.push(id), appVersion, owner: "acme", catalogUrl: CATALOG_URL, installDependencies: async () => {}, fetch: fakeFetch });
  return { installer, pluginManager, userDir, requests, deactivated, store };
}

describe("PluginInstaller", () => {
  it("lists the catalog's plugins that have a release for this oneClient, without a token", async () => {
    const { installer, requests } = setup({ "oneclient-demo": tarball({ "package/oneclient.json": manifest("oneclient-demo") }) });
    expect(await installer.listAvailable()).toEqual([{ id: "oneclient-demo", description: "oneclient-demo plugin", latest: "1.2.3", versions: ["1.2.3"] }]);
    expect(requests.every((r) => r.auth === undefined)).toBe(true);
  });

  it("offers only the versions that support this oneClient and installs the newest of those", async () => {
    const extra = {
      "oneclient-demo": [
        { version: "2.0.0", app: ">=0.2.0", engine: "^0.1.0", url: releaseUrl("oneclient-demo", "2.0.0"), sha512: "sha512-x" },
        { version: "1.5.0", app: ">=0.1.0 <0.2.0", engine: "^0.1.0", url: releaseUrl("oneclient-demo", "1.5.0"), sha512: "sha512-x" },
        { version: "1.9.0", app: ">=0.1.0", engine: "^99.0.0", url: releaseUrl("oneclient-demo", "1.9.0"), sha512: "sha512-x" },
      ],
    };
    const { installer } = setup({ "oneclient-demo": tarball({ "package/oneclient.json": manifest("oneclient-demo") }) }, { extra });
    // 2.0.0 needs a newer app, 1.9.0 a newer plugin API: 1.5.0 is the newest that fits.
    expect((await installer.listAvailable())[0]).toMatchObject({ latest: "1.5.0", versions: ["1.5.0", "1.2.3"] });
    await expect(installer.install("oneclient-demo", "2.0.0")).rejects.toThrow(/needs oneClient >=0.2.0 \(this is 0.1.0\)/);
    await expect(installer.remoteInfo("oneclient-demo")).resolves.toMatchObject({ latest: "1.5.0" });
  });

  it("hides a plugin none of whose releases support this oneClient", async () => {
    const { installer } = setup({}, { extra: { "oneclient-future": [{ version: "1.0.0", app: ">=5.0.0", engine: "^0.1.0", url: releaseUrl("oneclient-future", "1.0.0"), sha512: "sha512-x" }] } });
    expect(await installer.listAvailable()).toEqual([]);
    await expect(installer.remoteInfo("oneclient-future")).rejects.toThrow(/no version for oneClient 0\.1\.0 \(the newest, 1\.0\.0, needs oneClient >=5\.0\.0\)/);
  });

  it("downloads, extracts and loads a plugin, then uninstalls it", async () => {
    const { installer, pluginManager, userDir, deactivated } = setup({ "oneclient-demo": tarball({ "package/oneclient.json": manifest("oneclient-demo"), "package/dist/main.js": "module.exports = {};" }) });
    const summary = await installer.install("oneclient-demo");
    expect(summary).toMatchObject({ id: "oneclient-demo", version: "1.2.3", removable: true });
    expect(existsSync(join(userDir, "oneclient-demo", "dist", "main.js"))).toBe(true);
    expect(pluginManager.getRecord("oneclient-demo")?.state).toBe("inactive");

    await installer.uninstall("oneclient-demo");
    expect(deactivated).toEqual(["oneclient-demo"]);
    expect(pluginManager.getRecord("oneclient-demo")).toBeUndefined();
    expect(existsSync(join(userDir, "oneclient-demo"))).toBe(false);
  });

  it("replaces an installed plugin when installing it again", async () => {
    const { installer, pluginManager, deactivated } = setup({ "oneclient-demo": tarball({ "package/oneclient.json": manifest("oneclient-demo") }) });
    await installer.install("oneclient-demo");
    await installer.install("oneclient-demo");
    expect(deactivated).toEqual(["oneclient-demo"]);
    expect(pluginManager.getRecords()).toHaveLength(1);
  });

  it("removes a plugin that needs a newer oneClient", async () => {
    const { installer, pluginManager, userDir } = setup({ "oneclient-future": tarball({ "package/oneclient.json": manifest("oneclient-future", "^99.0.0") }) });
    await expect(installer.install("oneclient-future")).rejects.toThrow(/engine/);
    expect(pluginManager.getRecord("oneclient-future")).toBeUndefined();
    expect(existsSync(join(userDir, "oneclient-future"))).toBe(false);
  });

  it("rejects a package whose manifest names a different plugin", async () => {
    const { installer, userDir } = setup({ "oneclient-demo": tarball({ "package/oneclient.json": manifest("oneclient-other") }) });
    await expect(installer.install("oneclient-demo")).rejects.toThrow(/not "oneclient-demo"/);
    expect(existsSync(join(userDir, ".installing-oneclient-demo"))).toBe(false);
  });

  it("refuses to replace or uninstall a bundled plugin", async () => {
    const { installer, pluginManager, userDir } = setup({ "oneclient-demo": tarball({ "package/oneclient.json": manifest("oneclient-demo") }) });
    const bundled = join(home, "bundled");
    await extractTarball(tarball({ "package/oneclient.json": manifest("oneclient-demo") }), bundled);
    await pluginManager.add(bundled).then(() => undefined);
    // `add` marks what it loads as installed; a bundled one is loaded by scan(), so mark it the way scan() does.
    const record = pluginManager.getRecord("oneclient-demo")!;
    record.removable = false;
    await expect(installer.install("oneclient-demo")).rejects.toThrow(/bundled/);
    await expect(installer.uninstall("oneclient-demo")).rejects.toThrow(/bundled/);
    expect(pluginManager.getRecord("oneclient-demo")).toBe(record);
    expect(existsSync(userDir) ? existsSync(join(userDir, ".installing-oneclient-demo")) : false).toBe(false);
  });

  it("reads a plugin's README.md from its GitHub repository", async () => {
    const seen: string[] = [];
    const reader = new PluginInstaller({
      userDir: join(home, "p"),
      pluginManager: new PluginManager([], new ContributionRegistry(), new PluginMetadataStore(new ConfigStore(join(home, "c")))),
      secrets: { get: async () => "ghp_test" } as unknown as FileSecretStore,
      deactivate: async () => {},
      appVersion: "0.1.0",
      owner: "acme",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(`${String(input)} ${(init?.headers as Record<string, string>)["Authorization"]}`);
        return String(input).includes("oneclient-demo") ? new Response("# Demo\n\nHello") : new Response("nope", { status: 404 });
      }) as typeof fetch,
    });
    expect(await reader.githubReadme("oneclient-demo")).toEqual({ markdown: "# Demo\n\nHello", url: "https://github.com/acme/OneClient/blob/main/packages/plugins/oneclient-demo/README.md" });
    expect(seen[0]).toBe("https://api.github.com/repos/acme/OneClient/contents/packages/plugins/oneclient-demo/README.md?ref=main Bearer ghp_test");
    expect(await reader.githubReadme("oneclient-missing")).toBeUndefined();
    expect(await reader.githubReadme("../etc/passwd")).toBeUndefined();
  });

  it("works without a token, which is optional and used when saved", async () => {
    const { installer, requests } = setup({ "oneclient-demo": tarball({ "package/oneclient.json": manifest("oneclient-demo") }) });
    expect(await installer.info()).toMatchObject({ hasToken: false, appVersion: "0.1.0", url: CATALOG_URL });
    await installer.setToken("  ghp_new ");
    expect((await installer.info()).hasToken).toBe(true);
    await installer.listAvailable();
    expect(requests.at(-1)).toEqual({ url: CATALOG_URL, auth: "Bearer ghp_new" });
  });

  it("explains a catalog that can't be loaded", async () => {
    const missing = new PluginInstaller({
      userDir: join(home, "p"),
      pluginManager: new PluginManager([], new ContributionRegistry(), new PluginMetadataStore(new ConfigStore(join(home, "c")))),
      secrets: { get: async () => undefined } as unknown as FileSecretStore,
      deactivate: async () => {},
      appVersion: "0.1.0",
      owner: "acme",
      catalogUrl: CATALOG_URL,
      fetch: (async () => new Response("", { status: 404 })) as typeof fetch,
    });
    await expect(missing.listAvailable()).rejects.toThrow(/plugin\.json\) wasn't found/);
  });

  it("rejects a download that doesn't match its checksum", async () => {
    const good = tarball({ "package/oneclient.json": manifest("oneclient-demo") });
    // The catalog advertises `good`'s checksum but the download is different bytes.
    const tampered = new PluginInstaller({
      userDir: join(home, "plugins2"),
      pluginManager: new PluginManager([], new ContributionRegistry(), new PluginMetadataStore(new ConfigStore(join(home, "cfg2")))),
      secrets: { get: async () => "t" } as unknown as FileSecretStore,
      deactivate: async () => {},
      appVersion: "0.1.0",
      owner: "acme",
      catalogUrl: CATALOG_URL,
      installDependencies: async () => {},
      fetch: (async (input: string | URL | Request) =>
        String(input).includes("/releases/download/")
          ? new Response(new Uint8Array(tarball({ "package/oneclient.json": manifest("oneclient-demo"), "package/x": "evil" })))
          : Response.json({ schema: 1, plugins: { "oneclient-demo": { releases: [{ version: "1.2.3", app: "*", engine: "^0.1.0", url: releaseUrl("oneclient-demo"), sha512: integrity(good) }] } } })) as typeof fetch,
    });
    await expect(tampered.install("oneclient-demo")).rejects.toThrow(/checksum/);
  });
});

describe("extractTarball", () => {
  it("rejects paths that escape the destination", async () => {
    await expect(extractTarball(tarball({ "package/../../evil.txt": "x" }), join(home, "out"))).rejects.toThrow(/unsafe/);
    expect(existsSync(join(home, "evil.txt"))).toBe(false);
  });
});
