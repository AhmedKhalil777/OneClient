import type { PluginContext } from "@oneclient/plugin-api";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { dropAll } from "./sessions.js";
import { setLogSink } from "./log.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-keycloak activated");

  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider()));
  // Every request the plugin sends is logged to the app's Output panel (secrets masked, see log.ts).
  const requests = context.createOutputChannel("Requests");
  setLogSink((entry) => {
    const status = entry.status === undefined ? "failed" : String(entry.status);
    const message = `${entry.method} ${entry.path} → ${status} (${entry.ms} ms)${entry.op ? ` · ${entry.op}` : ""}`;
    const detail = [
      entry.error && !entry.status ? entry.error : "",
      entry.server,
      entry.request ? `Request body:\n${entry.request}` : "",
      entry.response ? `Response:\n${entry.response}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    requests.log(entry.error ? "error" : "info", message, detail);
  });
  for (const handler of createCommandHandlers()) {
    context.subscriptions.push(context.registerCommand(handler));
  }
}

export function deactivate(): void {
  dropAll();
}
