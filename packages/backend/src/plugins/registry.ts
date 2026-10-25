import type { PluginManifest } from "@oneclient/plugin-api";
import type { ContributionRegistrySnapshot } from "../shared/types.js";

/**
 * In-memory merge of every loaded plugin's `contributes` block. The
 * renderer never sees plugin code — only snapshots of this registry,
 * pushed over IPC whenever a plugin is added/removed.
 */
export class ContributionRegistry {
  private readonly byPlugin = new Map<string, NonNullable<PluginManifest["contributes"]>>();
  private readonly listeners = new Set<(snapshot: ContributionRegistrySnapshot) => void>();

  addPlugin(pluginId: string, contributes: PluginManifest["contributes"]): void {
    this.byPlugin.set(pluginId, contributes ?? {});
    this.emit();
  }

  removePlugin(pluginId: string): void {
    if (this.byPlugin.delete(pluginId)) {
      this.emit();
    }
  }

  onChanged(listener: (snapshot: ContributionRegistrySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ContributionRegistrySnapshot {
    const result: ContributionRegistrySnapshot = {
      connectionTypes: [],
      explorerNodes: [],
      explorerSections: [],
      views: [],
      commands: [],
      themes: [],
      iconThemes: [],
      searchProviders: [],
      icons: [],
      menus: [],
      quickActions: [],
      extensions: [],
    };
    for (const [pluginId, contributes] of this.byPlugin) {
      for (const c of contributes.connectionTypes ?? []) {
        result.connectionTypes.push({ ...c, pluginId });
      }
      for (const c of contributes.explorerNodes ?? []) {
        result.explorerNodes.push({ ...c, pluginId });
      }
      for (const c of contributes.explorerSections ?? []) result.explorerSections.push({ ...c, pluginId });
      for (const c of contributes.views ?? []) {
        result.views.push({ ...c, pluginId });
      }
      for (const c of contributes.commands ?? []) {
        result.commands.push({ ...c, pluginId });
      }
      for (const c of contributes.themes ?? []) result.themes.push({ ...c, pluginId });
      for (const c of contributes.iconThemes ?? []) result.iconThemes.push({ ...c, pluginId });
      for (const c of contributes.searchProviders ?? []) result.searchProviders.push({ ...c, pluginId });
      for (const c of contributes.icons ?? []) result.icons.push({ ...c, pluginId });
      for (const c of contributes.menus ?? []) result.menus.push({ ...c, pluginId });
      for (const c of contributes.quickActions ?? []) result.quickActions.push({ ...c, pluginId });
      for (const [point, items] of Object.entries(contributes.extensions ?? {})) {
        result.extensions.push({ point, pluginId, items: items.map((item) => ({ ...item })) });
      }
    }
    return result;
  }

  /**
   * Everything plugins contributed to extension point `point`, each item tagged with its plugin.
   * Core doesn't interpret the items — the plugin that owns the point does.
   */
  getExtensions(point: string): Array<Record<string, unknown> & { pluginId: string }> {
    const out: Array<Record<string, unknown> & { pluginId: string }> = [];
    for (const [pluginId, contributes] of this.byPlugin) {
      for (const item of contributes.extensions?.[point] ?? []) out.push({ ...item, pluginId });
    }
    return out;
  }

  /** Which plugin owns a given connection type, if any. */
  findConnectionTypeOwner(typeId: string): string | undefined {
    for (const [pluginId, contributes] of this.byPlugin) {
      if (contributes.connectionTypes?.some((c) => c.id === typeId)) return pluginId;
    }
    return undefined;
  }

  findCommandOwner(commandId: string): string | undefined {
    for (const [pluginId, contributes] of this.byPlugin) {
      if (contributes.commands?.some((c) => c.id === commandId)) return pluginId;
    }
    return undefined;
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
