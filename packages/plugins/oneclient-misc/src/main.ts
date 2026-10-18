import type { FileEditorRequest, PluginContext, TransformRequest, TransformResult } from "@oneclient/plugin-api";
import { formatJson, jsonSymbols, jsonTokens, minifyJson } from "./json.js";
import { formatSql, lowercaseKeywords, sqlSymbols, sqlTokens, uppercaseKeywords } from "./sql.js";
import { markdownPreview, markdownSymbols, markdownTokens } from "./markdown.js";
import { ensureFinalNewline, removeDuplicateLines, sortLinesAscending, sortLinesDescending, trimTrailingWhitespace } from "./transforms.js";
import { formatXml, xmlSymbols, xmlTokens } from "./xml.js";

/**
 * Miscellaneous file-editor support, one extension-host process for five file-type contributions to the Files
 * editor's `oneclient.editors` point (declared in oneclient.json): JSON, XML, SQL, Markdown and text utilities.
 * The Files editor calls these commands with one `{ text, fileName, … }` request (see plugin-api/src/file-editor.ts).
 */
function request<T extends FileEditorRequest>(args: unknown[]): T {
  const req = args[0] as T | undefined;
  if (!req || typeof req.text !== "string") throw new Error("Expected a { text, fileName } request.");
  return req;
}

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-misc activated");
  const on = (commandId: string, run: (args: unknown[]) => unknown) =>
    context.subscriptions.push(context.registerCommand({ commandId, execute: (args) => run(args) }));

  // JSON
  on("json.format", (args) => {
    const r = request<TransformRequest>(args);
    return formatJson(r.text, r.tabSize ?? 2, r.insertSpaces ?? true);
  });
  on("json.minify", (args) => minifyJson(request(args).text));
  on("json.symbols", (args) => jsonSymbols(request(args).text));
  on("json.tokens", (args) => jsonTokens(request(args).text));

  // XML
  on("xml.format", (args) => {
    const r = request<TransformRequest>(args);
    return formatXml(r.text, r.tabSize ?? 2, r.insertSpaces ?? true);
  });
  on("xml.symbols", (args) => xmlSymbols(request(args).text));
  on("xml.tokens", (args) => xmlTokens(request(args).text));

  // SQL
  on("sql.format", (args) => {
    const r = request<TransformRequest>(args);
    return formatSql(r.text, r.tabSize ?? 4, r.insertSpaces ?? true);
  });
  on("sql.symbols", (args) => sqlSymbols(request(args).text));
  on("sql.tokens", (args) => sqlTokens(request(args).text));
  on("sql.uppercaseKeywords", (args) => uppercaseKeywords(request(args).text));
  on("sql.lowercaseKeywords", (args) => lowercaseKeywords(request(args).text));

  // Markdown
  on("markdown.symbols", (args) => markdownSymbols(request(args).text));
  on("markdown.tokens", (args) => markdownTokens(request(args).text));
  on("markdown.preview", (args) => markdownPreview(request(args).text));

  // Text utilities (offered for every file)
  const transforms: Record<string, (req: TransformRequest) => TransformResult> = {
    "texttools.sortAscending": sortLinesAscending,
    "texttools.sortDescending": sortLinesDescending,
    "texttools.removeDuplicates": removeDuplicateLines,
    "texttools.trimTrailingWhitespace": trimTrailingWhitespace,
    "texttools.ensureFinalNewline": ensureFinalNewline,
  };
  for (const [commandId, run] of Object.entries(transforms)) on(commandId, (args) => run(request<TransformRequest>(args)));
}
