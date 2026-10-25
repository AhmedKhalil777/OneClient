import { csharpTokens, cssTokens, javascriptTokens, typescriptTokens, yamlTokens } from "@oneclient/editor-core";
import type { FileEditorRequest, PluginContext, TransformRequest, TransformResult } from "@oneclient/plugin-api";
import { formatJson, jsonSymbols, jsonTokens, minifyJson } from "./json.js";
import { formatSql, lowercaseKeywords, sqlSymbols, sqlTokens, uppercaseKeywords } from "./sql.js";
import { markdownPreview, markdownSymbols, markdownTokens } from "./markdown.js";
import { ensureFinalNewline, removeDuplicateLines, sortLinesAscending, sortLinesDescending, trimTrailingWhitespace } from "./transforms.js";
import { formatXml, xmlSymbols, xmlTokens } from "./xml.js";

/**
 * Miscellaneous file-editor support, one extension-host process for the file-type contributions to the Files
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

  // SVG: the text stays editable (XML), the preview shows the picture. Rendered as an <img>, so scripts in it never run.
  on("svg.preview", (args) => ({
    ok: true,
    html: `<img class="svg" alt="SVG preview" src="data:image/svg+xml;base64,${Buffer.from(request(args).text, "utf8").toString("base64")}">`,
    css: ".svg{display:block;max-width:100%;margin:0 auto;background:repeating-conic-gradient(#808080 0% 25%,#b0b0b0 0% 50%) 50%/16px 16px}",
  }));

  // SQL
  on("sql.format", (args) => {
    const r = request<TransformRequest>(args);
    return formatSql(r.text, r.tabSize ?? 4, r.insertSpaces ?? true);
  });
  on("sql.symbols", (args) => sqlSymbols(request(args).text));
  on("sql.tokens", (args) => sqlTokens(request(args).text));
  on("sql.uppercaseKeywords", (args) => uppercaseKeywords(request(args).text));
  on("sql.lowercaseKeywords", (args) => lowercaseKeywords(request(args).text));

  // Code (tokenizers live in @oneclient/editor-core)
  on("typescript.tokens", (args) => typescriptTokens(request(args).text));
  on("tsx.tokens", (args) => typescriptTokens(request(args).text, true));
  on("javascript.tokens", (args) => javascriptTokens(request(args).text));
  on("jsx.tokens", (args) => javascriptTokens(request(args).text, true));
  on("css.tokens", (args) => cssTokens(request(args).text));
  on("scss.tokens", (args) => cssTokens(request(args).text, true));
  on("yaml.tokens", (args) => yamlTokens(request(args).text));
  on("csharp.tokens", (args) => csharpTokens(request(args).text));

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
