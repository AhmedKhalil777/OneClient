import type { FileEditorRequest, PluginContext, TransformRequest } from "@oneclient/plugin-api";
import { formatXml, xmlSymbols, xmlTokens } from "./xml.js";

function request<T extends FileEditorRequest>(args: unknown[]): T {
  const req = args[0] as T | undefined;
  if (!req || typeof req.text !== "string") throw new Error("Expected a { text, fileName } request.");
  return req;
}

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-xml activated");
  const on = (commandId: string, run: (args: unknown[]) => unknown) =>
    context.subscriptions.push(context.registerCommand({ commandId, execute: (args) => run(args) }));

  on("xml.format", (args) => {
    const r = request<TransformRequest>(args);
    return formatXml(r.text, r.tabSize ?? 2, r.insertSpaces ?? true);
  });
  on("xml.symbols", (args) => xmlSymbols(request(args).text));
  on("xml.tokens", (args) => xmlTokens(request(args).text));
}
