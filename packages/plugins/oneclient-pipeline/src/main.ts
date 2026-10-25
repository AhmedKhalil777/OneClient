import type { PluginContext } from "@oneclient/plugin-api";
import { createCommandHandlers, createConnectionProvider, createEditorViewHandler, createExplorerProvider } from "./plugin.js";
import { PipelineService } from "./service.js";

let service: PipelineService | undefined;

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-pipeline activated");
  service = new PipelineService(context);
  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider(service)));
  context.subscriptions.push(context.registerView("pipeline.editor", createEditorViewHandler(service)));
  for (const handler of createCommandHandlers(service)) context.subscriptions.push(context.registerCommand(handler));
}

export function deactivate(): void {
  service?.cancelAll();
  service = undefined;
}
