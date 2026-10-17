import type { JsonSchemaObject, UiSchema } from "./json-schema.js";
import type { Logger } from "./logging.js";
import type { SecretStore } from "./secrets.js";

/**
 * Runtime context passed to a ConnectionProvider's lifecycle methods.
 * Scoped per-plugin (its own logger/secrets), not per-connection.
 */
export interface ConnectionContext {
  readonly logger: Logger;
  readonly secrets: SecretStore;
  readonly signal: AbortSignal;
  /**
   * The saved connection's id, if this call is against an already-saved
   * connection (`connect`/`disconnect`). Absent during `test()`, which
   * runs against a config the user hasn't saved yet. Cache any live
   * session/handle under this id if you manage more than one connection
   * of the same type concurrently — explorer/command calls receive the
   * same id so they can look the session back up.
   */
  readonly connectionId?: string;
}

export interface ConnectionTestResult {
  success: boolean;
  message?: string;
  latencyMs?: number;
}

/**
 * An opaque, serializable handle to a live connection. `TState` is private
 * to the provider (e.g. a pool reference) and never crosses the extension
 * host boundary — only `id`/`typeId` are visible to core/renderer.
 */
export interface ConnectionHandle<TState = unknown> {
  readonly id: string;
  readonly typeId: string;
  /** Provider-private state. Never serialized over IPC. */
  readonly state: TState;
}

/**
 * Implemented once per connection type a plugin contributes (e.g. one
 * instance for `postgres`, one for `postgres-ssl-tunnel` if a plugin wanted
 * to split them). Registered at activation time via
 * `PluginContext.registerConnectionProvider`.
 *
 * `configSchema`/`uiSchema` drive the Tier 1 generic form the core renders
 * for "New Connection" — the plugin never writes form JSX for this tier.
 */
export interface ConnectionProvider<TConfig = Record<string, unknown>, TState = unknown> {
  /** Must match a `contributes.connectionTypes[].id` entry in the manifest. */
  readonly typeId: string;

  /** JSON Schema describing the connection config object. */
  readonly configSchema: JsonSchemaObject;

  /** Optional layout/widget hints for the generic form renderer. */
  readonly uiSchema?: UiSchema;

  /** Open a live connection. Must honor `context.signal` (cancel on disable/shutdown). */
  connect(config: TConfig, context: ConnectionContext): Promise<ConnectionHandle<TState>>;

  /** Validate reachability/credentials without keeping the connection open. */
  test(config: TConfig, context: ConnectionContext): Promise<ConnectionTestResult>;

  /** Release any resources held by `handle`. Must be safe to call twice. */
  disconnect(handle: ConnectionHandle<TState>, context: ConnectionContext): Promise<void>;
}
