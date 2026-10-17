import type { PluginContext } from "@oneclient/plugin-api";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { createDashboardViewHandler } from "./dashboard-view.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { sessions } from "./sessions.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-docker activated");

  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider()));
  context.subscriptions.push(context.registerView("docker.dashboard", createDashboardViewHandler()));
  for (const handler of createCommandHandlers()) {
    context.subscriptions.push(context.registerCommand(handler));
  }
}

export function deactivate(): void {
  sessions.clear();
}
