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

