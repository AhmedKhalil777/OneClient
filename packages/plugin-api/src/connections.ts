import type { ConnectionTestResult } from "./connection.js";

/**
 * The user's saved connections — of every plugin's connection types — so plugins can work together. The Docker plugin
 * uses this to start a PostgreSQL container and hand the user a ready PostgreSQL connection, and to show which
 * containers already have one.
 *
 * ```ts
 * const { success } = await context.connections.test("postgres", { host: "127.0.0.1", port: 5432, password });
 * if (success) await context.connections.create({ typeId: "postgres", name: "Local PostgreSQL", config });
 * ```
 *
 * Secrets never cross plugins: `list()` returns the saved (public) settings only, and passwords given to `create()`
 * are moved into the secret store using the owning plugin's schema (fields marked `"x-secret": true`).
 */
export interface SavedConnection {
  readonly id: string;
  readonly name: string;
  /** The connection type (a `contributes.connectionTypes[].id`). */
  readonly typeId: string;
  /** The plugin that owns `typeId`. */
  readonly pluginId: string;
  /** Saved settings without secrets. */
  readonly config: Readonly<Record<string, unknown>>;
}

export interface NewConnection {
  /** Any installed plugin's connection type, e.g. "postgres". The owning plugin is activated if needed. */
  typeId: string;
  name: string;
  /** Settings as the owning plugin's connection form would submit them, secrets included. */
  config: Record<string, unknown>;
}

export interface Connections {
  list(): Promise<SavedConnection[]>;
  /** Saves a connection (it appears in the owning plugin's sidebar right away) and returns its id. */
  create(connection: NewConnection): Promise<{ id: string }>;
  /** Runs the owning plugin's connection test without saving anything. */
  test(typeId: string, config: Record<string, unknown>): Promise<ConnectionTestResult>;
}

/**
 * Read-only access to `contributes.extensions` points of every enabled plugin — the generic way plugins offer data
 * to each other. Each entry carries the contributing plugin's id.
 *
 * ```ts
 * const templates = await context.contributions.get<ContainerTemplate>("docker.containerTemplates");
 * ```
 */
export interface Contributions {
  get<T = Record<string, unknown>>(point: string): Promise<Array<T & { readonly pluginId: string }>>;
}
