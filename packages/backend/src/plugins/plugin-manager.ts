import { EventEmitter } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import { PLUGIN_API_VERSION, type PluginManifest } from "@oneclient/plugin-api";
import type { PluginState, PluginSummary } from "../shared/types.js";
import type { PluginMetadataStore } from "../db/plugin-metadata-store.js";
import { validateManifest } from "./manifest-validator.js";
import type { ContributionRegistry } from "./registry.js";

export interface PluginRecord {
  id: string;
  rootDir: string;
  manifest: PluginManifest;
  state: PluginState;
  error?: string;
  /** Lives in the user plugins folder (installed from the registry), so it can be uninstalled; bundled plugins can't. */
  removable?: boolean;
}

/**
 * Scans one or more plugin directories (each immediate subdirectory is one
 * plugin), validates `oneclient.json` against the schema, checks
 * `engines.oneclient` compatibility, and merges valid plugins' contributes
 * into the ContributionRegistry. Invalid/incompatible plugins are kept
 * around (for the Plugin Manager UI to explain *why*) but never reach the
 * registry or get activated — this is the "reject incompatible engines"
 * requirement from the spec.
 *
 * Emits `"changed"` with the current PluginSummary[] whenever the set of
 * known plugins changes, and `"loaded"` with a PluginRecord for every
 * plugin that passed validation (the caller — main/index.ts — decides
 * whether/when to activate it, keeping activation policy out of this
 * class).
 */
export class PluginManager extends EventEmitter {
  private readonly records = new Map<string, PluginRecord>();

  constructor(
    private readonly pluginDirs: string[],
    private readonly registry: ContributionRegistry,
    private readonly metadata: PluginMetadataStore,
  ) {
    super();
  }

  /** Persists the user's enable/disable choice and updates in-memory state accordingly. */
  setEnabled(pluginId: string, enabled: boolean): void {
    const record = this.records.get(pluginId);
    if (!record) return;
    this.metadata.setEnabled(pluginId, enabled);
    if (enabled) {
      if (record.state === "disabled") {
        record.state = "inactive";
        record.error = undefined;
        this.registry.addPlugin(record.id, record.manifest.contributes);
        this.emit("loaded", record);
      }
    } else {
      record.state = "disabled";
      this.registry.removePlugin(record.id);
      this.emit("disabled", record);
    }
    this.emitChanged();
  }

  async scan(): Promise<void> {
    for (const [index, dir] of this.pluginDirs.entries()) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue; // dir doesn't exist — fine, e.g. no user plugins installed yet
      }
      // The first directory is the user's plugins folder; the rest are bundled with the app.
      for (const entry of entries) {
        await this.loadOne(join(dir, entry), index === 0);
      }
    }
    this.emitChanged();
  }

  /** Loads one plugin folder that appeared after start-up (an install); resolves to its record, if it has a manifest. */
  async add(rootDir: string): Promise<PluginRecord | undefined> {
    const record = await this.loadOne(rootDir, true);
    this.emitChanged();
    return record;
  }

  /** Forgets a plugin (an uninstall): its contributions leave the registry. The caller stops it and deletes its folder. */
  remove(pluginId: string): void {
    if (!this.records.delete(pluginId)) return;
    this.registry.removePlugin(pluginId);
    this.emitChanged();
  }

  getRecords(): PluginRecord[] {
    return [...this.records.values()];
  }

  getRecord(pluginId: string): PluginRecord | undefined {
    return this.records.get(pluginId);
  }

  setState(pluginId: string, state: PluginState, error?: string): void {
    const record = this.records.get(pluginId);
    if (!record) return;
    record.state = state;
    record.error = error;
    this.emitChanged();
  }

  private async loadOne(rootDir: string, removable = false): Promise<PluginRecord | undefined> {
    let raw: unknown;
    try {
      const text = await readFile(join(rootDir, "oneclient.json"), "utf-8");
      raw = JSON.parse(text);
    } catch {
      return undefined; // not a plugin directory (no manifest) — silently skip
    }

    const validation = validateManifest(raw);
    if (!validation.valid || !validation.manifest) {
      const id = typeof (raw as Partial<PluginManifest>)?.name === "string"
        ? (raw as PluginManifest).name
        : rootDir;
      const invalid: PluginRecord = {
        id,
        rootDir,
        manifest: raw as PluginManifest,
        state: "invalid",
        error: validation.errors?.join("; ") ?? "Manifest failed schema validation.",
        removable,
      };
      this.records.set(id, invalid);
      return invalid;
    }

    const manifest = validation.manifest;
    const compatible = semver.satisfies(PLUGIN_API_VERSION, manifest.engines.oneclient, {
      includePrerelease: true,
    });

    if (!compatible) {
      const incompatible: PluginRecord = {
        id: manifest.name,
        rootDir,
        manifest,
        state: "incompatible",
        error: `Requires oneclient engine "${manifest.engines.oneclient}", host provides ${PLUGIN_API_VERSION}.`,
        removable,
      };
      this.records.set(manifest.name, incompatible);
      return incompatible;
    }

    const previousVersion = this.metadata.recordVersion(manifest.name, manifest.version);
    if (previousVersion && previousVersion !== manifest.version) {
      // eslint-disable-next-line no-console
      console.info(`[plugins] ${manifest.name} changed from ${previousVersion} to ${manifest.version}`);
    }
    const enabled = this.metadata.isEnabled(manifest.name);
    const record: PluginRecord = {
      id: manifest.name,
      rootDir,
      manifest,
      state: enabled ? "inactive" : "disabled",
      removable,
    };
    this.records.set(manifest.name, record);
    if (!enabled) return record;
    this.registry.addPlugin(manifest.name, manifest.contributes);
    this.emit("loaded", record);
    return record;
  }

  private emitChanged(): void {
    this.emit("changed", this.getRecords().map(summarizePlugin));
  }
}

/** What the UI is told about a plugin: identity, state, and its manifest's feature list (normalised to titles). */
export function summarizePlugin(r: ReturnType<PluginManager["getRecords"]>[number]): PluginSummary {
  const features = r.manifest?.features;
  return {
    id: r.id,
    displayName: r.manifest?.displayName,
    description: r.manifest?.description,
    version: r.manifest?.version ?? "0.0.0",
    state: r.state,
    error: r.error,
    icon: r.manifest?.icon,
    ...(r.removable ? { removable: true } : {}),
    ...(features?.length
      ? {
          features: features.map((g) => ({
            category: g.category,
            items: g.items.map((it) => (typeof it === "string" ? { title: it } : { title: it.title, ...(it.description ? { description: it.description } : {}) })),
          })),
        }
      : {}),
  };
}
