import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A saved connection as it appears in `oneclient.json`. Secrets are NOT here — see FileSecretStore. */
export interface StoredConnection {
  id: string;
  name: string;
  typeId: string;
  pluginId: string;
  /** Everything except `x-secret` fields. */
  config: Record<string, unknown>;
  createdAt: string;
  /** Version of the plugin that last wrote this connection's config — lets a plugin (or an import) spot older data. */
  pluginVersion?: string;
}

export interface ThemeSettings {
  colorTheme?: string;
  iconTheme?: string;
}

export interface PluginState {
  enabled: boolean;
  /** Last version of the plugin the app saw (changes are logged, so upgrades/downgrades are traceable). */
  version?: string;
}

/** A folder open in the Explorer (the workspace). */
export interface StoredFolder {
  id: string;
  name: string;
  /** Absolute path. */
  path: string;
}

export interface ConfigFile {
  version: number;
  /** App settings (theme choices). */
  settings: ThemeSettings;
  /** Plugins the user has touched or the app has seen (anything absent is enabled). */
  plugins: Record<string, PluginState>;
  connections: StoredConnection[];
  /** The folders open in the Explorer, in order. */
  workspace: { folders: StoredFolder[] };
}

/** Before v2, Explorer folders were connections of the old "Files" plugin. */
const LEGACY_FOLDER = { pluginId: "oneclient-files", typeId: "folder" };
/** Extensions that became part of core (v2) or were removed: their plugin entries are dropped. */
const RETIRED_PLUGINS = ["oneclient-files", "oneclient-terminal", "oneclient-sample"];

/**
 * The file format version of `oneclient.json`.
 *
 * HOW TO CHANGE THE FORMAT (see docs/CONFIG.md):
 *   1. Bump CONFIG_VERSION.
 *   2. Append a migration to MIGRATIONS that upgrades *from the previous version* — never edit an old one.
 *   3. Add a test in test/config-store.test.ts feeding a file of the old shape through `migrateConfig`.
 * A file is migrated in memory on load, the original is copied to `oneclient.json.v<N>.bak`, and the upgraded
 * file is written back. A file from a NEWER app is never touched: the app refuses to start with a clear message.
 */
export const CONFIG_VERSION = 2;

type Json = Record<string, unknown>;
interface Migration {
  /** Upgrades data of version `from` to `from + 1`. */
  from: number;
  describe: string;
  run(data: Json): Json;
}

export const MIGRATIONS: Migration[] = [
  {
    from: 0,
    describe: "unversioned file → v1 (normalize the shape: settings, plugins, connections)",
    run: (data) => ({
      ...data,
      settings: isObject(data.settings) ? data.settings : {},
      plugins: isObject(data.plugins) ? data.plugins : {},
      connections: Array.isArray(data.connections) ? data.connections : [],
    }),
  },
  {
    from: 1,
    describe: "Explorer folders become the workspace (they were connections of the Files plugin, which is now part of core)",
    run: (data) => {
      const connections = Array.isArray(data.connections) ? (data.connections as Json[]) : [];
      const isFolder = (c: Json) => c.pluginId === LEGACY_FOLDER.pluginId && c.typeId === LEGACY_FOLDER.typeId;
      const folders = connections
        .filter((c) => isFolder(c) && isObject(c.config) && typeof c.config.path === "string" && c.config.path)
        .map((c) => ({ id: String(c.id), name: String(c.name ?? ""), path: String((c.config as Json).path) }));
      const plugins = isObject(data.plugins) ? { ...data.plugins } : {};
      for (const id of RETIRED_PLUGINS) delete plugins[id];
      return { ...data, plugins, connections: connections.filter((c) => !isFolder(c)), workspace: { folders } };
    },
  },
];

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Thrown when a file was written by a newer oneClient than this one understands. */
export class ConfigVersionError extends Error {
  constructor(
    readonly file: string,
    readonly fileVersion: number,
    readonly supportedVersion: number,
  ) {
    super(`${file} was written by a newer version of oneClient (file format ${fileVersion}; this version understands up to ${supportedVersion}). Update oneClient, or move the file aside to start fresh.`);
    this.name = "ConfigVersionError";
  }
}

export interface MigrationResult {
  data: Json;
  from: number;
  to: number;
  applied: string[];
}

/** Brings a parsed config document (any older version) up to CONFIG_VERSION. Throws for newer versions. */
export function migrateConfig(raw: unknown, source = "oneclient.json"): MigrationResult {
  if (!isObject(raw)) throw new Error("the file is not a JSON object");
  const from = raw.version === undefined ? 0 : raw.version;
  if (typeof from !== "number" || !Number.isInteger(from) || from < 0) throw new Error(`invalid "version": ${JSON.stringify(raw.version)}`);
  if (from > CONFIG_VERSION) throw new ConfigVersionError(source, from, CONFIG_VERSION);
  let data: Json = { ...raw };
  let version = from;
  const applied: string[] = [];
  while (version < CONFIG_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === version);
    if (!step) throw new Error(`no migration from config version ${version}`);
    data = { ...step.run(data), version: version + 1 };
    applied.push(`v${version} → v${version + 1}: ${step.describe}`);
    version++;
  }
  return { data, from, to: version, applied };
}

/** `~/.oneclient`, or `$ONECLIENT_HOME` when set (tests, portable installs). */
export function oneclientHome(): string {
  return process.env.ONECLIENT_HOME?.trim() || join(homedir(), ".oneclient");
}

const emptyConfig = (): ConfigFile => ({ version: CONFIG_VERSION, settings: {}, plugins: {}, connections: [], workspace: { folders: [] } });

/**
 * The app's own metadata, as one human-readable JSON file (`~/.oneclient/oneclient.json`): saved connections,
 * enabled/disabled plugins and theme choices. It holds no secrets, so it is safe to copy, share or commit.
 * It is versioned (see CONFIG_VERSION) and migrated forward automatically. Writes are atomic (temp file + rename)
 * and a damaged file is set aside as `oneclient.json.broken-<time>` rather than overwritten.
 */
export class ConfigStore {
  readonly dir: string;
  readonly filePath: string;
  readonly secretsPath: string;
  private data: ConfigFile;

  constructor(
    dir: string = oneclientHome(),
    private readonly log: (message: string) => void = () => {},
  ) {
    this.dir = dir;
    this.filePath = join(dir, "oneclient.json");
    this.secretsPath = join(dir, "secrets.json");
    mkdirSync(dir, { recursive: true });
    this.data = this.load();
  }

  private load(): ConfigFile {
    if (!existsSync(this.filePath)) return emptyConfig();
    let result: MigrationResult;
    try {
      result = migrateConfig(JSON.parse(readFileSync(this.filePath, "utf-8")), this.filePath);
    } catch (err) {
      if (err instanceof ConfigVersionError) throw err; // never touch a newer file
      const aside = `${this.filePath}.broken-${Date.now()}`;
      try {
        renameSync(this.filePath, aside);
      } catch {
        /* nothing more we can do */
      }
      this.log(`oneclient.json could not be read (${err instanceof Error ? err.message : String(err)}); moved to ${aside} and started fresh.`);
      return emptyConfig();
    }
    const raw = result.data;
    const config: ConfigFile = {
      version: CONFIG_VERSION,
      settings: isObject(raw.settings) ? (raw.settings as ThemeSettings) : {},
      plugins: isObject(raw.plugins) ? (raw.plugins as Record<string, PluginState>) : {},
      connections: Array.isArray(raw.connections) ? raw.connections.filter(isStoredConnection) : [],
      workspace: { folders: isObject(raw.workspace) && Array.isArray(raw.workspace.folders) ? raw.workspace.folders.filter(isStoredFolder) : [] },
    };
    if (result.applied.length > 0) {
      try {
        copyFileSync(this.filePath, `${this.filePath}.v${result.from}.bak`);
      } catch {
        /* a failed backup must not block start-up */
      }
      this.data = config;
      this.save();
      this.log(`oneclient.json upgraded from v${result.from} to v${result.to} (backup: oneclient.json.v${result.from}.bak).`);
    }
    return config;
  }

  private save(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, "utf-8");
    renameSync(tmp, this.filePath);
  }

  // ---- settings
  getSettings(): ThemeSettings {
    return { ...this.data.settings };
  }
  setSettings(settings: ThemeSettings): void {
    this.data.settings = { ...settings };
    this.save();
  }

  // ---- plugins
  isPluginEnabled(pluginId: string): boolean {
    return this.data.plugins[pluginId]?.enabled !== false;
  }
  setPluginEnabled(pluginId: string, enabled: boolean): void {
    this.data.plugins[pluginId] = { ...this.data.plugins[pluginId], enabled };
    this.save();
  }
  /** Remembers the plugin's version; returns the previously seen one (undefined the first time). */
  recordPluginVersion(pluginId: string, version: string): string | undefined {
    const previous = this.data.plugins[pluginId]?.version;
    if (previous === version) return previous;
    this.data.plugins[pluginId] = { enabled: this.data.plugins[pluginId]?.enabled !== false, ...this.data.plugins[pluginId], version };
    this.save();
    return previous;
  }

  // ---- connections
  listConnections(): StoredConnection[] {
    return this.data.connections.map((c) => ({ ...c }));
  }
  getConnection(id: string): StoredConnection | undefined {
    const c = this.data.connections.find((x) => x.id === id);
    return c ? { ...c } : undefined;
  }
  /** Adds one or more connections with a single write. */
  addConnections(connections: StoredConnection[]): void {
    this.data.connections.push(...connections);
    this.save();
  }
  removeConnection(id: string): void {
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    this.save();
  }

  // ---- workspace (Explorer folders)
  listFolders(): StoredFolder[] {
    return this.data.workspace.folders.map((f) => ({ ...f }));
  }
  addFolder(folder: StoredFolder): void {
    this.data.workspace.folders.push({ ...folder });
    this.save();
  }
  removeFolder(id: string): void {
    this.data.workspace.folders = this.data.workspace.folders.filter((f) => f.id !== id);
    this.save();
  }
}

export function isStoredFolder(v: unknown): v is StoredFolder {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return typeof f.id === "string" && typeof f.name === "string" && typeof f.path === "string" && f.path.length > 0;
}

export function isStoredConnection(v: unknown): v is StoredConnection {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    typeof c.typeId === "string" &&
    typeof c.pluginId === "string" &&
    typeof c.config === "object" &&
    c.config !== null &&
    !Array.isArray(c.config)
  );
}
