import type { PluginContext } from "@oneclient/plugin-api";
import { setBlobLogger } from "./api.js";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { closeAll } from "./sessions.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-azure-blob activated");

  // Uploads, deletes, moves and other changes are logged to the Output panel.
  const changes = context.createOutputChannel("Changes");
  setBlobLogger((level, message, detail) => changes.log(level, message, detail));

  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider()));
  for (const handler of createCommandHandlers()) context.subscriptions.push(context.registerCommand(handler));
}

export function deactivate(): void {
  closeAll();
}
