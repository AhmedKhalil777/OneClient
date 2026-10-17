/**
 * Per-plugin secret storage. Backed by Electron `safeStorage` (OS keychain)
 * on the main-process side; plugins never see the underlying encryption —
 * they only get this key/value facade, scoped to their own plugin id so
 * one plugin cannot read another's secrets.
 *
 * Connection passwords, API tokens, etc. referenced by a Tier 1 form field
 * marked `"x-secret": true` are written here by core, keyed by a
 * core-generated id, and only the id (not the value) is stored in the
 * connection's own config. Plugin code calls `get(id)` to resolve it at
 * `connect()` time.
 */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
