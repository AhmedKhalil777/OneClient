import type { PluginContext } from "@oneclient/plugin-api";
import { createSqlCore } from "@oneclient/sql-core";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { describeError } from "./errors.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { fakerTool } from "./faker/api.js";
import { folders } from "./folders.js";
import { cancelQuery, executeQuery } from "./query-runner.js";
import { closeAll, requireSession, closeWindow } from "./sessions.js";
import { createDatabase } from "./databases.js";
import { mssqlPlanAccess } from "./plan.js";
import { mssqlTableAccess } from "./table-access.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-mssql activated");

  // The SQL core: query windows, results, history and FAST TOOLS (fast queries + this plugin's fakers).
  const core = createSqlCore({
    prefix: "mssql",
    executeQuery,
    cancelQuery,
    ensureConnected: (connectionId) => void requireSession(connectionId),
    describeError,
    host: context,
    releaseWindow: closeWindow,
    productName: "SQL Server",
    tableAccess: mssqlTableAccess,
    planAccess: mssqlPlanAccess,
    createDatabase,
    folders,
    tools: [fakerTool],
  });

  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider(core.sections)));
  context.subscriptions.push(context.registerView("mssql.query", core.views.query));
  context.subscriptions.push(context.registerView("mssql.results", core.views.results));
  for (const handler of [...core.commands, ...createCommandHandlers(core)]) {
    context.subscriptions.push(context.registerCommand(handler));
  }
}

export async function deactivate(): Promise<void> {
  await closeAll();
}
