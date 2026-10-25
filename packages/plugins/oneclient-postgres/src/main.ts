import type { PluginContext } from "@oneclient/plugin-api";
import { createSqlCore } from "@oneclient/sql-core";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { describeError } from "./errors.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { cancelQuery, executeQuery } from "./query-runner.js";
import { closeAll, requireSession } from "./sessions.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-postgres activated");

  // The SQL core: query windows, results, history and FAST TOOLS (fast queries).
  const core = createSqlCore({
    prefix: "postgres",
    untitledQuery: "Query",
    executeQuery,
    cancelQuery,
    ensureConnected: (connectionId) => void requireSession(connectionId),
    describeError,
  });

  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider(core.fastTools)));
  context.subscriptions.push(context.registerView("postgres.query", core.views.query));
  context.subscriptions.push(context.registerView("postgres.results", core.views.results));
  for (const handler of [...core.commands, ...createCommandHandlers(core)]) context.subscriptions.push(context.registerCommand(handler));
}

export async function deactivate(): Promise<void> {
  await closeAll();
}
