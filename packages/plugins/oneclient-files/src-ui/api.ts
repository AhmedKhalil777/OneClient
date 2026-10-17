import type { FileEditorError } from "@oneclient/plugin-api";

// Mirrors the result types in ../src/commands.ts (the UI bundle can't import Node-side code).
export type ReadResult =
  | { ok: true; content: string; eol: "\n" | "\r\n"; bom: boolean; size: number }
  | { ok: false; error: string; reason?: "binary" | "tooLarge" };

export type WriteResult = { ok: true; size: number } | { ok: false; error: string };

const params = new URLSearchParams(location.search);
export const connectionId = params.get("connectionId") ?? "";
/** Root-relative, "/"-separated path of the file this editor instance is for. */
export const filePath = params.get("path") ?? "";

export const readFile = () =>
  window.oneclientView.invokeCommand("files.readFile", [{ connectionId, path: filePath }]) as Promise<ReadResult>;

export const writeFile = (content: string) =>
  window.oneclientView.invokeCommand("files.writeFile", [{ connectionId, path: filePath, content }]) as Promise<WriteResult>;

/** Base name of the open file ("tsconfig.json"). */
export const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);

/**
 * Calls a feature command contributed by another plugin (format, symbols, …). Never throws: a plugin that
 * is disabled, crashed or slow just means that feature is unavailable, not that the editor breaks.
 */
export async function callFeature<T extends { ok: boolean }>(command: string, request: unknown): Promise<T | { ok: false; error: FileEditorError }> {
  try {
    return (await window.oneclientView.invokeCommand(command, [request])) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Electron prefixes errors that crossed IPC: "Error invoking remote method '…': Error: <the real message>".
    return { ok: false, error: { message: message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") } };
  }
}
