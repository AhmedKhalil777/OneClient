import type { CommandHandler } from "./commands.js";
import type { ConnectionProvider } from "./connection.js";
import type { ExplorerProvider } from "./explorer.js";
import type { Logger } from "./logging.js";
import type { OutputChannel } from "./output.js";
import type { SecretStore } from "./secrets.js";
import type { Workspace } from "./workspace.js";
import type { ViewMessageHandler } from "./ui.js";

export interface Disposable {
  dispose(): void;
}

/**
 * Passed to a plugin's `activate()`. This — plus whatever the plugin
 * imports from the rest of this package — is the plugin's entire window
 * onto the host app. There is deliberately no `require("electron")`,
 * filesystem, or network escape hatch here; plugins reach the outside
 * world through whatever Node APIs/npm deps they bundle themselves
 * (see ARCHITECTURE.md § Trust model for why that is NOT a security
 * sandbox, only a crash/API-surface boundary).
 */
export interface PluginContext {
  readonly pluginId: string;
  /** Absolute path to this plugin's installed directory. */
  readonly extensionPath: string;
  readonly logger: Logger;
  readonly secrets: SecretStore;

  registerConnectionProvider(provider: ConnectionProvider): Disposable;
  registerExplorerProvider(provider: ExplorerProvider): Disposable;
  registerCommand(handler: CommandHandler): Disposable;
  /** `viewId` must match a `contributes.views[].id` in the manifest. */
  registerView(viewId: string, handler: ViewMessageHandler): Disposable;

  /**
   * Creates (or returns) a named channel in the app-wide Output panel. Several channels per plugin are fine —
   * e.g. "Requests" and "Tasks". `logger` output also appears there, in the plugin's "Log" channel.
   */
  createOutputChannel(name: string): OutputChannel;

  /** The folders open in core's Explorer, and opening files in core's editor — see workspace.ts. */
  readonly workspace: Workspace;

  /** Disposables registered here are disposed automatically on deactivate/disable. */
  readonly subscriptions: Disposable[];
}

export type PluginActivate = (context: PluginContext) => void | Promise<void>;
export type PluginDeactivate = () => void | Promise<void>;

/** Shape a plugin's `main` module must export. */
export interface PluginModule {
  activate: PluginActivate;
  deactivate?: PluginDeactivate;
}
