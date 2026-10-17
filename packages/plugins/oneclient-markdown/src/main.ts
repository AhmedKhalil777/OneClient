import type { FileEditorRequest, PluginContext } from "@oneclient/plugin-api";
import { markdownPreview, markdownSymbols, markdownTokens } from "./markdown.js";

function request(args: unknown[]): FileEditorRequest {
  const req = args[0] as FileEditorRequest | undefined;
  if (!req || typeof req.text !== "string") throw new Error("Expected a { text, fileName } request.");
  return req;
}

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-markdown activated");
  const on = (commandId: string, run: (text: string) => unknown) =>
    context.subscriptions.push(context.registerCommand({ commandId, execute: (args) => run(request(args).text) }));

  on("markdown.symbols", markdownSymbols);
  on("markdown.tokens", markdownTokens);
  on("markdown.preview", markdownPreview);
}
