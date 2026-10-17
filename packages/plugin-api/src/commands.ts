import type { Logger } from "./logging.js";
import type { SecretStore } from "./secrets.js";

export interface CommandContext {
  readonly logger: Logger;
  readonly secrets: SecretStore;
  readonly signal: AbortSignal;
}

/**
 * Handles one command id contributed in the manifest's
 * `contributes.commands`. Invoked from the command palette, a context
 * menu (`when: contextValue == "..."`), or a Tier 2 view posting a message
 * back through `PluginContext.registerCommand`'s registration.
 */
export interface CommandHandler {
  /** Must match a `contributes.commands[].id` entry in the manifest. */
  readonly commandId: string;

  execute(args: unknown[], context: CommandContext): Promise<unknown> | unknown;
}
