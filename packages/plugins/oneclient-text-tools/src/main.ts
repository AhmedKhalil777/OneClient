import type { PluginContext, TransformRequest, TransformResult } from "@oneclient/plugin-api";
import {
  ensureFinalNewline,
  removeDuplicateLines,
  sortLinesAscending,
  sortLinesDescending,
  trimTrailingWhitespace,
} from "./transforms.js";

function request(args: unknown[]): TransformRequest {
  const req = args[0] as TransformRequest | undefined;
  if (!req || typeof req.text !== "string") throw new Error("Expected a { text, fileName } request.");
  return req;
}

export function activate(context: PluginContext): void {
  context.logger.info("oneclient-text-tools activated");
  const actions: Record<string, (req: TransformRequest) => TransformResult> = {
    "texttools.sortAscending": sortLinesAscending,
    "texttools.sortDescending": sortLinesDescending,
    "texttools.removeDuplicates": removeDuplicateLines,
    "texttools.trimTrailingWhitespace": trimTrailingWhitespace,
    "texttools.ensureFinalNewline": ensureFinalNewline,
  };
  for (const [commandId, run] of Object.entries(actions)) {
    context.subscriptions.push(context.registerCommand({ commandId, execute: (args) => run(request(args)) }));
  }
}
