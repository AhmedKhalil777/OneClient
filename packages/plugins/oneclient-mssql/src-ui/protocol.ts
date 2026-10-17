import type { QueryRun, ServerInfo } from "./api.js";

/** Messages between the query window / Query Results views and the plugin backend (see ../src/views.ts). */

export interface WindowInfo extends ServerInfo {
  database?: string | null;
}

export type WindowState = { kind: "running"; started: number } | { kind: "done"; run: QueryRun } | { kind: "failed"; error: string };

export interface WindowUpdate {
  type: "update";
  windowId: string;
  title: string;
  info: WindowInfo | null;
  state: WindowState;
}

/** Backend → Query Results panel. */
export type ToResults =
  | WindowUpdate
  | { type: "activate"; windowId: string; title: string }
  | { type: "snapshot"; windows: WindowUpdate[]; active: { windowId: string; title: string } | null };

/** Backend → query window (every window of the connection receives it; filter on windowId). */
export type ToQueryWindow =
  | {
      type: "done";
      windowId: string;
      queryId: string;
      database: string | null;
      hasErrors: boolean;
      cancelled: boolean;
      elapsedMs: number;
      rows: number;
    }
  | { type: "failed"; windowId: string; queryId: string; error: string }
  | { type: "goToLine"; windowId: string; line: number };
