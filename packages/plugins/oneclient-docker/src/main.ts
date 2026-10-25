import type { PluginContext } from "@oneclient/plugin-api";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { createDashboardViewHandler } from "./dashboard-view.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { Infrastructure } from "./infra.js";
import { TestContainers } from "./test-runner.js";
import { sessions } from "./sessions.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-docker activated");

  const infra = new Infrastructure(context);
  const tests = new TestContainers(context);
  tests.startReaper();
  context.subscriptions.push({ dispose: () => tests.stopReaper() });
  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider(infra, tests)));
  context.subscriptions.push(context.registerView("docker.dashboard", createDashboardViewHandler()));
  for (const handler of createCommandHandlers(infra, tests)) {
    context.subscriptions.push(context.registerCommand(handler));
  }
}

export function deactivate(): void {
  sessions.clear();
}
