import type { PluginContext } from "@oneclient/plugin-api";
import { createChatHandler } from "./chat.js";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { closeAll } from "./sessions.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-ai activated");
  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider()));
  context.subscriptions.push(context.registerView("ai.chat", createChatHandler(context)));
  for (const handler of createCommandHandlers()) context.subscriptions.push(context.registerCommand(handler));
}

export function deactivate(): void {
  closeAll();
}
