import type { FileEditorRequest, PluginContext, TransformRequest } from "@oneclient/plugin-api";
import { formatJson, jsonSymbols, jsonTokens, minifyJson } from "./json.js";

/** Feature commands are called by the Files editor with one request object (see plugin-api/src/file-editor.ts). */
function request<T extends FileEditorRequest>(args: unknown[]): T {
  const req = args[0] as T | undefined;
  if (!req || typeof req.text !== "string") throw new Error("Expected a { text, fileName } request.");
  return req;
}

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-json activated");
  const on = (commandId: string, run: (args: unknown[]) => unknown) =>
    context.subscriptions.push(context.registerCommand({ commandId, execute: (args) => run(args) }));

  on("json.format", (args) => {
    const r = request<TransformRequest>(args);
    return formatJson(r.text, r.tabSize ?? 2, r.insertSpaces ?? true);
  });
  on("json.minify", (args) => minifyJson(request(args).text));
  on("json.symbols", (args) => jsonSymbols(request(args).text));
  on("json.tokens", (args) => jsonTokens(request(args).text));
}
