import type { ConfigStore } from "../config/config-store.js";

/**
 * Enable/disable state per plugin id, kept in `oneclient.json`. Plugin discovery itself is always a filesystem
 * scan (see PluginManager) — this only remembers the user's choice across restarts, so a disabled plugin stays
 * disabled after the app reopens.
 */
export class PluginMetadataStore {
  constructor(private readonly config: ConfigStore) {}

  /** A plugin the user never turned off is enabled. */
  isEnabled(pluginId: string): boolean {
    return this.config.isPluginEnabled(pluginId);
  }

  /** Records the installed version; returns the one seen last time (undefined on first sight). */
  recordVersion(pluginId: string, version: string): string | undefined {
    return this.config.recordPluginVersion(pluginId, version);
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    this.config.setPluginEnabled(pluginId, enabled);
  }
}
