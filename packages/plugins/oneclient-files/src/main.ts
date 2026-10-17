import type { PluginContext } from "@oneclient/plugin-api";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { roots } from "./roots.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-files activated");

  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider()));
  for (const handler of createCommandHandlers()) {
    context.subscriptions.push(context.registerCommand(handler));
  }
}

export function deactivate(): void {
  roots.clear();
}
