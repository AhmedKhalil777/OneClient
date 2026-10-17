import type { PluginContext } from "@oneclient/plugin-api";
import { setCommandLogger } from "./api.js";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { closeAll } from "./sessions.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-redis activated");

  // Writes (edits, deletes, CLI commands that change data) are logged to the Output panel.
  const commands = context.createOutputChannel("Commands");
  setCommandLogger((level, message, detail) => commands.log(level, message, detail));

  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider()));
  for (const handler of createCommandHandlers()) context.subscriptions.push(context.registerCommand(handler));
}

export async function deactivate(): Promise<void> {
  await closeAll();
}
