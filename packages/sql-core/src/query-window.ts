import type { TreeNode } from "@oneclient/plugin-api";

export interface QueryWindowOptions {
  database?: string | undefined;
  sql?: string;
  autorun?: boolean;
  title?: string;
  history?: boolean;
  /** A stable window (and tab) id — opening the same id again focuses that tab. Default: a fresh window each time. */
  windowId?: string;
  /** The window edits this fast query: its Save writes back to the file. */
  fastQuery?: { file: string; name: string; anyDatabase: boolean };
}

export type QueryWindowFactory = (opts: QueryWindowOptions) => TreeNode;

/**
 * A query window is opened by returning `openNode` — a node whose `openView` (the `<prefix>.query` view) core opens
 * as a tab. A fresh id each time = a fresh window (`<untitled>1.sql`, `<untitled>2.sql`, …).
 */
export function createQueryWindowFactory(prefix: string, untitled = "SQLQuery"): QueryWindowFactory {
  let counter = 0;
  return (opts) => {
    counter++;
    const params: Record<string, string> = { windowId: opts.windowId ?? `q${Date.now()}-${counter}` };
    if (opts.database) params.database = opts.database;
    if (opts.sql) params.sql = opts.sql;
    if (opts.autorun) params.autorun = "1";
    if (opts.history) params.history = "1";
    if (opts.fastQuery) {
      params.fastQueryFile = opts.fastQuery.file;
      params.fastQueryName = opts.fastQuery.name;
      if (opts.fastQuery.anyDatabase) params.fastQueryAnyDatabase = "1";
    }
    const title = opts.title ?? `${untitled}${counter}.sql`;
    params.title = title; // the window labels its results in the Query Results panel with this
    return {
      id: params.windowId!,
      label: title,
      nodeType: `${prefix}.query`,
      collapsible: "none",
      openView: { viewId: `${prefix}.query`, title, params },
    };
  };
}
