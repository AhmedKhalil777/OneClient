import { randomUUID } from "node:crypto";
import type { ConnectionTestResult, JsonSchemaObject } from "@oneclient/plugin-api";
import type { ConnectionSummary, ConnectionTypeFormInfo } from "../shared/types.js";
import type { ContributionRegistry } from "../plugins/registry.js";
import type { ProviderDirectory } from "../plugins/provider-directory.js";
import semver from "semver";
import { type ConfigStore, type StoredConnection, isStoredConnection, migrateConfig } from "../config/config-store.js";
import type { FileSecretStore } from "../secrets/secret-store.js";

type EnsureActivated = (pluginId: string) => Promise<void>;
type Invoke = (
  pluginId: string,
  kind: "connection",
  target: string,
  method: string,
  args: unknown[],
  connectionId?: string,
) => Promise<unknown>;

export const EXPORT_FORMAT = "oneclient-connections";
/** Version of the export document. Importers accept this and older; a newer one is refused with a clear message. */
export const EXPORT_VERSION = 1;

export interface ExportedConnection extends StoredConnection {
  /** Plain-text secrets, only when exported with "include secrets". */
  secrets?: Record<string, string>;
}

export interface ConnectionsExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  /** Plugin versions the connections were saved with, so an import can warn about older plugins. */
  plugins: Record<string, string>;
  includesSecrets: boolean;
  connections: ExportedConnection[];
}

export interface ImportResult {
  added: number;
  /** Already saved (same id). */
  skipped: number;
  /** Entries that weren't valid connections. */
  invalid: number;
  /** Added, but the file carried no passwords — the user has to enter them. */
  withoutSecrets: number;
  /** Things worth knowing: missing or older plugins. */
  warnings: string[];
}

/**
 * Owns the saved connections (in oneclient.json), the secret-splitting boundary around
 * it, and lazy connect-on-first-use. Never holds a `ConnectionHandle`
 * itself — those stay inside the owning extension host; this class only
 * knows a connection has been `connect()`-ed once, not what came back.
 */
export class ConnectionManager {
  private readonly connected = new Set<string>();

  constructor(
    private readonly config: ConfigStore,
    private readonly registry: ContributionRegistry,
    private readonly providers: ProviderDirectory,
    private readonly secrets: FileSecretStore,
    private readonly ensureActivated: EnsureActivated,
    private readonly invoke: Invoke,
    /** Installed version of a plugin (undefined if it isn't installed). */
    private readonly getPluginVersion: (pluginId: string) => string | undefined = () => undefined,
  ) {}

  private readonly changeListeners = new Set<() => void>();

  /** Fires after connections are added or removed (by the UI, an import, or a plugin). */
  onChanged(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.changeListeners) listener();
  }

  list(): ConnectionSummary[] {
    return this.config.listConnections().map((c) => ({ id: c.id, name: c.name, typeId: c.typeId, pluginId: c.pluginId }));
  }

  /** Like `list()`, with each connection's saved settings — never its secrets (those live in the secret store). */
  listWithConfig(): Array<ConnectionSummary & { config: Record<string, unknown> }> {
    return this.config.listConnections().map((c) => ({ id: c.id, name: c.name, typeId: c.typeId, pluginId: c.pluginId, config: { ...c.config } }));
  }

  async getFormInfo(typeId: string): Promise<ConnectionTypeFormInfo> {
    const pluginId = this.resolveOwner(typeId);
    await this.ensureActivated(pluginId);
    const info = this.providers.getConnectionInfo(typeId);
    if (!info) {
      throw new Error(`Plugin "${pluginId}" did not register a provider for connection type "${typeId}".`);
    }
    return { typeId: info.typeId, pluginId: info.pluginId, configSchema: info.configSchema, uiSchema: info.uiSchema };
  }

  async test(typeId: string, config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const pluginId = this.resolveOwner(typeId);
    await this.ensureActivated(pluginId);
    const result = await this.invoke(pluginId, "connection", typeId, "test", [config]);
    return result as ConnectionTestResult;
  }

  async create(typeId: string, name: string, rawConfig: Record<string, unknown>): Promise<ConnectionSummary> {
    const pluginId = this.resolveOwner(typeId);
    await this.ensureActivated(pluginId);
    const info = this.providers.getConnectionInfo(typeId);
    if (!info) {
      throw new Error(`Plugin "${pluginId}" did not register a provider for connection type "${typeId}".`);
    }
    const id = randomUUID();
    const { publicConfig, secretValues } = splitSecrets(info.configSchema, withDefaults(info.configSchema, rawConfig));
    for (const [key, value] of Object.entries(secretValues)) {
      await this.secrets.set(`${id}:${key}`, value);
    }
    this.config.addConnections([{ id, name, typeId, pluginId, config: publicConfig, createdAt: new Date().toISOString(), ...pluginVersionField(this.getPluginVersion(pluginId)) }]);
    this.changed();
    return { id, name, typeId, pluginId };
  }

  /**
   * What the edit form needs: the saved settings (never secrets) and which secret fields this runtime has a value for.
   * The desktop app and the web server keep separate secret stores, so a connection made in one has no password in
   * the other until it's entered there once.
   */
  async getForEdit(id: string): Promise<{ id: string; name: string; typeId: string; pluginId: string; config: Record<string, unknown>; savedSecrets: string[]; missingSecrets: string[] }> {
    const row = this.config.getConnection(id);
    if (!row) throw new Error(`Unknown connection "${id}".`);
    const info = await this.getFormInfo(row.typeId);
    const secretKeys = Object.entries(info.configSchema.properties ?? {}).filter(([, p]) => p["x-secret"]).map(([k]) => k);
    const saved: string[] = [];
    for (const key of secretKeys) if ((await this.secrets.get(`${id}:${key}`)) !== undefined) saved.push(key);
    return { id, name: row.name, typeId: row.typeId, pluginId: row.pluginId, config: { ...row.config }, savedSecrets: saved, missingSecrets: secretKeys.filter((k) => !saved.includes(k)) };
  }

  /**
   * Saves new settings for an existing connection, keeping its id. A secret field left empty keeps the stored value;
   * a filled one replaces it. The connection reconnects with the new settings on next use.
   */
  async update(id: string, name: string, rawConfig: Record<string, unknown>): Promise<ConnectionSummary> {
    const row = this.config.getConnection(id);
    if (!row) throw new Error(`Unknown connection "${id}".`);
    await this.ensureActivated(row.pluginId);
    const info = this.providers.getConnectionInfo(row.typeId);
    if (!info) throw new Error(`Plugin "${row.pluginId}" did not register a provider for connection type "${row.typeId}".`);
    const { publicConfig, secretValues } = splitSecrets(info.configSchema, withDefaults(info.configSchema, rawConfig));
    for (const [key, value] of Object.entries(secretValues)) {
      if (value !== "") await this.secrets.set(`${id}:${key}`, value);
    }
    this.config.updateConnection(id, { name: name.trim() || row.name, config: publicConfig, ...pluginVersionField(this.getPluginVersion(row.pluginId)) });
    if (this.connected.delete(id)) {
      // Drop the old session; the next explorer/command use connects with the new settings.
      await this.invoke(row.pluginId, "connection", row.typeId, "disconnect", [], id).catch(() => undefined);
    }
    this.changed();
    return { id, name: name.trim() || row.name, typeId: row.typeId, pluginId: row.pluginId };
  }

  /** Tests settings typed into the edit form; empty secret fields use the connection's stored ones. */
  async testExisting(id: string, rawConfig: Record<string, unknown>): Promise<ConnectionTestResult> {
    const row = this.config.getConnection(id);
    if (!row) throw new Error(`Unknown connection "${id}".`);
    const info = await this.getFormInfo(row.typeId);
    const merged: Record<string, unknown> = { ...rawConfig };
    for (const [key, prop] of Object.entries(info.configSchema.properties ?? {})) {
      if (prop["x-secret"] && (merged[key] === undefined || merged[key] === "")) {
        const stored = await this.secrets.get(`${id}:${key}`);
        if (stored !== undefined) merged[key] = stored;
      }
    }
    return this.test(row.typeId, merged);
  }

  async delete(id: string): Promise<void> {
    this.config.removeConnection(id);
    await this.secrets.deleteByPrefix(`${id}:`);
    this.connected.delete(id);
    this.changed();
  }

  /** Reconstructs full config (public + secrets) and calls `connect()` once; no-op if already connected this session. */
  async ensureConnected(connectionId: string): Promise<{ pluginId: string; typeId: string }> {
    const row = this.config.getConnection(connectionId);
    if (!row) throw new Error(`Unknown connection "${connectionId}".`);

    await this.ensureActivated(row.pluginId);
    if (this.connected.has(connectionId)) return { pluginId: row.pluginId, typeId: row.typeId };

    const info = this.providers.getConnectionInfo(row.typeId);
    if (!info) throw new Error(`Plugin "${row.pluginId}" has not registered connection type "${row.typeId}".`);

    const publicConfig = row.config;
    const fullConfig = await mergeSecrets(info.configSchema, publicConfig, (key) =>
      this.secrets.get(`${connectionId}:${key}`),
    );
    await this.invoke(row.pluginId, "connection", row.typeId, "connect", [fullConfig], connectionId);
    this.connected.add(connectionId);
    return { pluginId: row.pluginId, typeId: row.typeId };
  }

  /**
   * The saved connections as a portable JSON document. Passwords and other secrets are left out unless
   * `includeSecrets` is set — they are then written in PLAIN TEXT, so the file must be handled like a password.
   */
  async exportConnections(includeSecrets: boolean): Promise<ConnectionsExport> {
    const connections: ExportedConnection[] = [];
    for (const c of this.config.listConnections()) {
      const secrets = includeSecrets ? await this.secrets.entriesByPrefix(`${c.id}:`) : {};
      connections.push({ ...c, ...(Object.keys(secrets).length > 0 ? { secrets } : {}) });
    }
    const plugins: Record<string, string> = {};
    for (const c of connections) {
      const v = c.pluginVersion ?? this.getPluginVersion(c.pluginId);
      if (v) plugins[c.pluginId] = v;
    }
    return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString(), includesSecrets: includeSecrets, plugins, connections };
  }

  /**
   * Adds the connections from an export file (or any `oneclient.json`). Connections whose id is already saved are
   * skipped, so importing the same file twice is harmless. Secrets in the file are stored encrypted.
   */
  async importConnections(document: unknown): Promise<ImportResult> {
    const doc = document as { format?: unknown; version?: unknown; plugins?: unknown; connections?: unknown } | null;
    let list = doc?.connections;
    let exportedPlugins: Record<string, string> = {};
    if (doc?.format === EXPORT_FORMAT) {
      if (typeof doc.version === "number" && doc.version > EXPORT_VERSION) {
        throw new Error(`This export was made by a newer version of oneClient (export format ${doc.version}; this version reads up to ${EXPORT_VERSION}). Update oneClient to import it.`);
      }
      if (doc.plugins && typeof doc.plugins === "object") exportedPlugins = doc.plugins as Record<string, string>;
    } else if (doc && typeof doc === "object" && Array.isArray(doc.connections)) {
      // Possibly a whole oneclient.json (any file-format version): bring it up to date first.
      const migrated = migrateConfig(doc, "the imported file").data;
      list = migrated.connections;
    }
    if (!Array.isArray(list)) throw new Error("This file has no \"connections\" list — it doesn't look like a oneClient export or oneclient.json.");
    const existing = new Set(this.config.listConnections().map((c) => c.id));
    const toAdd: StoredConnection[] = [];
    let skipped = 0;
    let invalid = 0;
    let withoutSecrets = 0;
    const warnings = new Set<string>();
    for (const item of list) {
      if (!isStoredConnection(item)) {
        invalid++;
        continue;
      }
      if (existing.has(item.id)) {
        skipped++;
        continue;
      }
      existing.add(item.id);
      const wanted = item.pluginVersion ?? exportedPlugins[item.pluginId];
      const have = this.getPluginVersion(item.pluginId);
      if (!have) warnings.add(`Plugin "${item.pluginId}" isn't installed — "${item.name}" won't appear until it is.`);
      else if (wanted && semver.valid(wanted) && semver.valid(have) && semver.lt(have, wanted)) {
        warnings.add(`"${item.name}" was saved with ${item.pluginId} ${wanted}, but ${have} is installed — update the plugin if it misbehaves.`);
      }
      const secrets = (item as { secrets?: unknown }).secrets;
      if (secrets && typeof secrets === "object") {
        for (const [key, value] of Object.entries(secrets as Record<string, unknown>)) {
          if (typeof value === "string") await this.secrets.set(`${item.id}:${key}`, value);
        }
      } else {
        withoutSecrets++;
      }
      toAdd.push({ id: item.id, name: item.name, typeId: item.typeId, pluginId: item.pluginId, config: item.config, createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(), ...pluginVersionField(typeof item.pluginVersion === "string" ? item.pluginVersion : have) });
    }
    if (toAdd.length > 0) {
      this.config.addConnections(toAdd);
      this.changed();
    }
    return { added: toAdd.length, skipped, invalid, withoutSecrets, warnings: [...warnings] };
  }

  private resolveOwner(typeId: string): string {
    const pluginId = this.registry.findConnectionTypeOwner(typeId);
    if (!pluginId) throw new Error(`No installed plugin contributes connection type "${typeId}".`);
    return pluginId;
  }
}

function splitSecrets(
  schema: JsonSchemaObject,
  config: Record<string, unknown>,
): { publicConfig: Record<string, unknown>; secretValues: Record<string, string> } {
  const publicConfig: Record<string, unknown> = { ...config };
  const secretValues: Record<string, string> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop["x-secret"] && key in publicConfig) {
      const value = publicConfig[key];
      if (typeof value === "string") secretValues[key] = value;
      delete publicConfig[key];
    }
  }
  return { publicConfig, secretValues };
}

/** Fills settings the caller left out with the schema's defaults (the connection form does the same). */
function withDefaults(schema: JsonSchemaObject, config: Record<string, unknown>): Record<string, unknown> {
  const filled: Record<string, unknown> = { ...config };
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (filled[key] === undefined && prop.default !== undefined) filled[key] = prop.default;
  }
  return filled;
}

async function mergeSecrets(
  schema: JsonSchemaObject,
  publicConfig: Record<string, unknown>,
  getSecret: (key: string) => Promise<string | undefined>,
): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = { ...publicConfig };
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop["x-secret"]) {
      const value = await getSecret(key);
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

const pluginVersionField = (version: string | undefined): { pluginVersion?: string } => (version ? { pluginVersion: version } : {});
