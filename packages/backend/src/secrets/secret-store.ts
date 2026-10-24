import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ConfigVersionError } from "../config/config-store.js";
import type { SecretCipher } from "../platform/platform.js";

/** File format version of secrets.json. v0 (legacy) was a bare `{ key: ciphertext }` map; v1 wraps it as `{ version, secrets }`. */
export const SECRETS_VERSION = 1;

/**
 * Secrets (passwords, client secrets, tokens) in `~/.oneclient/secrets.json`, each value encrypted before it touches
 * disk — by the desktop app with Electron `safeStorage` (OS keychain / DPAPI: only the same OS user on the same machine
 * can read it), by the web server with its own key (`secrets-server.json`, see node-platform.ts). They live apart from
 * `oneclient.json` so that file can be shared.
 *
 * Keys are namespaced `${pluginId}:${key}` / `${connectionId}:${key}` by callers, so plugins never see each other's.
 */
export class FileSecretStore {
  private data: Record<string, string> = {};

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher,
  ) {
    let raw: unknown;
    try {
      raw = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf-8")) : undefined;
    } catch {
      raw = undefined;
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const doc = raw as Record<string, unknown>;
      if (typeof doc.version === "number" && typeof doc.secrets === "object" && doc.secrets) {
        if (doc.version > SECRETS_VERSION) throw new ConfigVersionError(filePath, doc.version, SECRETS_VERSION);
        this.data = doc.secrets as Record<string, string>;
      } else {
        // v0: the bare map. Upgrade it to v1 right away (the ciphertext itself is unchanged).
        this.data = Object.fromEntries(Object.entries(doc).filter(([, v]) => typeof v === "string")) as Record<string, string>;
        this.save();
      }
    }
  }

  private save(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: SECRETS_VERSION, secrets: this.data }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  private decrypt(ciphertext: string): string | undefined {
    if (!this.cipher.available()) return undefined;
    try {
      return this.cipher.decrypt(ciphertext);
    } catch {
      return undefined; // written by another user or machine
    }
  }

  async get(key: string): Promise<string | undefined> {
    const ciphertext = this.data[key];
    return ciphertext === undefined ? undefined : this.decrypt(ciphertext);
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.cipher.available()) {
      throw new Error("OS-level secret encryption is not available on this machine.");
    }
    this.data[key] = this.cipher.encrypt(value);
    this.save();
  }

  async delete(key: string): Promise<void> {
    if (!(key in this.data)) return;
    delete this.data[key];
    this.save();
  }

  /** Deletes every secret whose key starts with `prefix` (e.g. a connection id). */
  async deleteByPrefix(prefix: string): Promise<void> {
    const keys = Object.keys(this.data).filter((k) => k.startsWith(prefix));
    if (keys.length === 0) return;
    for (const k of keys) delete this.data[k];
    this.save();
  }

  /** Decrypted `{ key-without-prefix: value }` for every secret under `prefix` (used by "export with secrets"). */
  async entriesByPrefix(prefix: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, c] of Object.entries(this.data)) {
      if (!k.startsWith(prefix)) continue;
      const v = this.decrypt(c);
      if (v !== undefined) out[k.slice(prefix.length)] = v;
    }
    return out;
  }
}
