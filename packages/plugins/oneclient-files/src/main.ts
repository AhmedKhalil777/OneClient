import type { PluginContext } from "@oneclient/plugin-api";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { createEditorViewHandler } from "./editor-hub.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { roots } from "./roots.js";
import { dropSearchCache } from "./search.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-files activated");

  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider()));
  context.subscriptions.push(context.registerView("files.editor", createEditorViewHandler()));
  for (const handler of createCommandHandlers()) {
    context.subscriptions.push(context.registerCommand(handler));
  }
}

export function deactivate(): void {
  roots.clear();
  dropSearchCache();
}
