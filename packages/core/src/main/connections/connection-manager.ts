import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ConnectionTestResult, JsonSchemaObject } from "@oneclient/plugin-api";
import type { ConnectionSummary, ConnectionTypeFormInfo } from "../../shared/types.js";
import type { ContributionRegistry } from "../plugins/registry.js";
import type { ProviderDirectory } from "../plugins/provider-directory.js";
import type { SqliteSecretStore } from "../secrets/secret-store.js";

type EnsureActivated = (pluginId: string) => Promise<void>;
type Invoke = (
  pluginId: string,
  kind: "connection",
  target: string,
  method: string,
  args: unknown[],
  connectionId?: string,
) => Promise<unknown>;

interface ConnectionRow {
  id: string;
  name: string;
  type_id: string;
  plugin_id: string;
  config_json: string;
}

/**
 * Owns the saved-connections table, the secret-splitting boundary around
 * it, and lazy connect-on-first-use. Never holds a `ConnectionHandle`
 * itself — those stay inside the owning extension host; this class only
 * knows a connection has been `connect()`-ed once, not what came back.
 */
export class ConnectionManager {
  private readonly connected = new Set<string>();

  constructor(
    private readonly db: Database.Database,
    private readonly registry: ContributionRegistry,
    private readonly providers: ProviderDirectory,
    private readonly secrets: SqliteSecretStore,
    private readonly ensureActivated: EnsureActivated,
    private readonly invoke: Invoke,
  ) {}

  list(): ConnectionSummary[] {
    const rows = this.db
      .prepare("SELECT id, name, type_id, plugin_id FROM connections ORDER BY created_at")
      .all() as Array<Pick<ConnectionRow, "id" | "name" | "type_id" | "plugin_id">>;
    return rows.map((r) => ({ id: r.id, name: r.name, typeId: r.type_id, pluginId: r.plugin_id }));
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
    const { publicConfig, secretValues } = splitSecrets(info.configSchema, rawConfig);
    for (const [key, value] of Object.entries(secretValues)) {
      await this.secrets.set(`${id}:${key}`, value);
    }
    this.db
      .prepare("INSERT INTO connections (id, name, type_id, plugin_id, config_json) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, typeId, pluginId, JSON.stringify(publicConfig));
    return { id, name, typeId, pluginId };
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM connections WHERE id = ?").run(id);
    await this.secrets.deleteByPrefix(`${id}:`);
    this.connected.delete(id);
  }

  /** Reconstructs full config (public + secrets) and calls `connect()` once; no-op if already connected this session. */
  async ensureConnected(connectionId: string): Promise<{ pluginId: string; typeId: string }> {
    const row = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(connectionId) as
      | ConnectionRow
      | undefined;
    if (!row) throw new Error(`Unknown connection "${connectionId}".`);

    await this.ensureActivated(row.plugin_id);
    if (this.connected.has(connectionId)) return { pluginId: row.plugin_id, typeId: row.type_id };

    const info = this.providers.getConnectionInfo(row.type_id);
    if (!info) throw new Error(`Plugin "${row.plugin_id}" has not registered connection type "${row.type_id}".`);

    const publicConfig = JSON.parse(row.config_json) as Record<string, unknown>;
    const fullConfig = await mergeSecrets(info.configSchema, publicConfig, (key) =>
      this.secrets.get(`${connectionId}:${key}`),
    );
    await this.invoke(row.plugin_id, "connection", row.type_id, "connect", [fullConfig], connectionId);
    this.connected.add(connectionId);
    return { pluginId: row.plugin_id, typeId: row.type_id };
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
