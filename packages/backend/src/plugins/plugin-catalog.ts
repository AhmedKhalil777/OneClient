import semver from "semver";

/** One released version of a plugin: a tarball attached to a GitHub Release, and what it needs. */
export interface CatalogRelease {
  version: string;
  /** oneClient versions it runs on (semver range). */
  app: string;
  /** Plugin-API versions it needs (semver range, the plugin's `engines.oneclient`). */
  engine: string;
  url: string;
  /** SRI checksum ("sha512-<base64>") of the tarball — a download that doesn't match is refused. */
  sha512: string;
  size?: number;
  publishedAt?: string;
}

export interface CatalogPlugin {
  description?: string;
  /** Newest first. */
  releases: CatalogRelease[];
}

/** plugin.json at the root of the repository: every plugin, its versions, and the app each one supports. */
export interface Catalog {
  schema: 1;
  plugins: Record<string, CatalogPlugin>;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const isRange = (v: unknown): v is string => typeof v === "string" && semver.validRange(v) !== null;

/** Reads plugin.json. Entries that are malformed are dropped (one bad release must not hide the rest); a file that isn't a catalog throws. */
export function parseCatalog(raw: unknown): Catalog {
  const doc = raw as { schema?: unknown; plugins?: unknown } | null;
  if (!doc || typeof doc !== "object" || doc.schema !== 1 || !doc.plugins || typeof doc.plugins !== "object") throw new Error("plugin.json isn't a oneClient plugin catalog (schema 1).");
  const plugins: Record<string, CatalogPlugin> = {};
  for (const [id, value] of Object.entries(doc.plugins as Record<string, { description?: unknown; releases?: unknown }>)) {
    if (!ID_PATTERN.test(id) || !Array.isArray(value?.releases)) continue;
    const releases: CatalogRelease[] = [];
    for (const r of value.releases as Array<Record<string, unknown>>) {
      if (typeof r?.["version"] !== "string" || !semver.valid(r["version"]) || !isRange(r["app"]) || !isRange(r["engine"])) continue;
      if (typeof r["url"] !== "string" || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(r["url"]) || typeof r["sha512"] !== "string" || !r["sha512"].startsWith("sha512-")) continue;
      releases.push({
        version: r["version"],
        app: r["app"],
        engine: r["engine"],
        url: r["url"],
        sha512: r["sha512"],
        ...(typeof r["size"] === "number" ? { size: r["size"] } : {}),
        ...(typeof r["publishedAt"] === "string" ? { publishedAt: r["publishedAt"] } : {}),
      });
    }
    releases.sort((a, b) => semver.rcompare(a.version, b.version));
    plugins[id] = { ...(typeof value.description === "string" ? { description: value.description } : {}), releases };
  }
  return { schema: 1, plugins };
}

/** Whether this release runs on this oneClient (`appVersion`) with this plugin API (`apiVersion`). */
export function supports(release: CatalogRelease, appVersion: string, apiVersion: string): boolean {
  return semver.satisfies(appVersion, release.app, { includePrerelease: true }) && semver.satisfies(apiVersion, release.engine, { includePrerelease: true });
}

/** The versions of a plugin that work with this app, newest first. */
export function compatibleReleases(plugin: CatalogPlugin, appVersion: string, apiVersion: string): CatalogRelease[] {
  return plugin.releases.filter((r) => supports(r, appVersion, apiVersion));
}
