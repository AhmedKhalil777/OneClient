import type { PluginContext } from "@oneclient/plugin-api";
import { setRequestLogger } from "./api.js";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { dropAllSessions } from "./sessions.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-http activated");

  // Every request that is sent is logged to the app's Output panel (headers have credentials masked).
  const requests = context.createOutputChannel("Requests");
  setRequestLogger((level, message, detail) => requests.log(level, message, detail));

  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider()));
  for (const handler of createCommandHandlers()) {
    context.subscriptions.push(context.registerCommand(handler));
  }
}

export function deactivate(): void {
  dropAllSessions();
}
