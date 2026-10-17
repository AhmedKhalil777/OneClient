import type Database from "better-sqlite3";

/**
 * Persisted enable/disable state per plugin id, backed by the `plugins`
 * table. Plugin discovery itself is always a filesystem scan (see
 * PluginManager) — this store only remembers the user's enabled/disabled
 * choice across restarts, so a disabled plugin stays disabled after the
 * app reopens instead of silently re-activating.
 */
export class PluginMetadataStore {
  constructor(private readonly db: Database.Database) {}

  /** Defaults a never-seen-before plugin id to enabled, persisting that default. */
  isEnabled(pluginId: string): boolean {
    const row = this.db.prepare("SELECT enabled FROM plugins WHERE id = ?").get(pluginId) as
      | { enabled: number }
      | undefined;
    if (!row) {
      this.db.prepare("INSERT INTO plugins (id, enabled) VALUES (?, 1)").run(pluginId);
      return true;
    }
    return row.enabled === 1;
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    this.db
      .prepare(
        `INSERT INTO plugins (id, enabled) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(pluginId, enabled ? 1 : 0);
  }
}
