import type { PluginContext } from "@oneclient/plugin-api";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { closeAll } from "./sessions.js";
import { createQueryViewHandler, createResultsViewHandler } from "./views.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-postgres activated");

  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider()));
  context.subscriptions.push(context.registerView("postgres.query", createQueryViewHandler()));
  context.subscriptions.push(context.registerView("postgres.results", createResultsViewHandler()));
  for (const handler of createCommandHandlers()) context.subscriptions.push(context.registerCommand(handler));
}

export async function deactivate(): Promise<void> {
  await closeAll();
}
