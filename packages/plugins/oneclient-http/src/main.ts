import type { PluginContext } from "@oneclient/plugin-api";
import { setRequestLogger } from "./api.js";
import { createCommandHandlers } from "./commands.js";
import { createConnectionProvider } from "./connection-provider.js";
import { createExplorerProvider } from "./explorer-provider.js";
import { httpFileLenses, httpFileSymbols, httpFileTokens } from "./httpfile.js";
import { convertCommandToHttpFile } from "./httpfile-convert.js";
import { runHttpFileRequest } from "./httpfile-run.js";
import { dropAllSessions } from "./sessions.js";

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-http activated");

  // Every request that is sent is logged to the app's Output panel (headers have credentials masked).
  const requests = context.createOutputChannel("Requests");
  setRequestLogger((level, message, detail) => requests.log(level, message, detail));

  context.subscriptions.push(context.registerConnectionProvider(createConnectionProvider()));
  context.subscriptions.push(context.registerExplorerProvider(createExplorerProvider()));
  // .http / .rest files: highlighting, breadcrumbs, a ▶ per request, and the engine that sends them.
  const fileCommand = (commandId: string, run: (text: string, fileName: string, args: unknown) => unknown) =>
    context.subscriptions.push(
      context.registerCommand({
        commandId,
        execute: (args) => {
          const r = (args[0] ?? {}) as { text?: unknown; fileName?: unknown; args?: unknown };
          if (typeof r.text !== "string") throw new Error("Expected a { text, fileName } request.");
          return run(r.text, typeof r.fileName === "string" ? r.fileName : "", r.args);
        },
      }),
    );
  fileCommand("http.file.tokens", (text) => httpFileTokens(text));
  fileCommand("http.file.symbols", (text) => httpFileSymbols(text));
  fileCommand("http.file.lenses", (text) => httpFileLenses(text));
  fileCommand("http.file.run", (text, fileName, args) => runHttpFileRequest(text, fileName, Number((args as { index?: unknown } | undefined)?.index ?? 0)));

  context.subscriptions.push(
    context.registerCommand({
      commandId: "http.file.fromCommand",
      execute: (args) => convertCommandToHttpFile((args[0] ?? {}) as Parameters<typeof convertCommandToHttpFile>[0]),
    }),
  );

  for (const handler of createCommandHandlers()) {
    context.subscriptions.push(context.registerCommand(handler));
  }
}

export function deactivate(): void {
  dropAllSessions();
}
