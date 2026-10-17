import type Database from "better-sqlite3";
import { safeStorage } from "electron";

/**
 * SQLite-backed, OS-keychain-encrypted secret store. Values are encrypted
 * with Electron `safeStorage` (which defers to the OS keychain/DPAPI)
 * before ever touching disk — the `secrets` table holds base64
 * ciphertext, never plaintext.
 *
 * Keys are namespaced `${pluginId}:${key}` by the caller (see
 * `ExtensionHostSupervisor`), so one plugin's secrets are never visible to
 * another even though they share one database file.
 */
export class SqliteSecretStore {
  constructor(private readonly db: Database.Database) {}

  async get(key: string): Promise<string | undefined> {
    const row = this.db.prepare("SELECT ciphertext FROM secrets WHERE key = ?").get(key) as
      | { ciphertext: string }
      | undefined;
    if (!row) return undefined;
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.decryptString(Buffer.from(row.ciphertext, "base64"));
  }

  async set(key: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS-level secret encryption is not available on this machine.");
    }
    const ciphertext = safeStorage.encryptString(value).toString("base64");
    this.db
      .prepare(
        `INSERT INTO secrets (key, ciphertext) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET ciphertext = excluded.ciphertext`,
      )
      .run(key, ciphertext);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM secrets WHERE key = ?").run(key);
  }

  /** Deletes every secret whose key starts with `prefix` (e.g. a connection id). */
  async deleteByPrefix(prefix: string): Promise<void> {
    this.db.prepare("DELETE FROM secrets WHERE key LIKE ?").run(`${prefix}%`);
  }
}
