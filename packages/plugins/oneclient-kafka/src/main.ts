import type { PluginContext } from "@oneclient/plugin-api";
import { setKafkaLogger } from "./api.js";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { closeAll } from "./sessions.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-kafka activated");

  // Topic changes, produced messages, offset resets and failures are logged to the Output panel.
  const changes = context.createOutputChannel("Changes");
  setKafkaLogger((level, message, detail) => changes.log(level, message, detail));

  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider()));
  for (const handler of createCommandHandlers()) context.subscriptions.push(context.registerCommand(handler));
}

export function deactivate(): Promise<void> {
  return closeAll();
}
