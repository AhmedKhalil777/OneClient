import type { TreeNode } from "@oneclient/plugin-api";
import type { FolderStore } from "../fast-tools/folder.js";
import type { QueryWindowFactory, QueryWindowOptions } from "../query-window.js";
import type { FastQueryDoc } from "./file.js";
import { type FastQueryEntry, deleteFastQueryFile, listFastQueries, readFastQueryFile, renameFastQueryFile, writeFastQueryFile } from "./store.js";

export const FAST_QUERY_ICON = "$(file-code)";

export interface FastQueries {
  /** Children of `<prefix>.fastQueriesRoot` / `<prefix>.fastQueryGroup`. */
  nodes(folder: string, node: TreeNode): Promise<TreeNode[]>;
  /** Its window, executing right away — in `database` if given, else the query's own; with neither, opened to pick one. */
  run(connectionId: string, file: string, database?: string): Promise<TreeNode>;
  /** A blank query window that saves as a new fast query. */
  newWindow(database: string | undefined): TreeNode;
  save(connectionId: string, doc: FastQueryDoc, file?: string): Promise<{ file: string; name: string }>;
  rename(connectionId: string, file: string, name: string): Promise<string>;
  remove(connectionId: string, file: string): Promise<void>;
}

/** Fast Queries: saved scripts (`*.query.sql` in the Fast Tools folder), grouped by database, run in one click. */
export function createFastQueries(prefix: string, folders: FolderStore, queryWindow: QueryWindowFactory): FastQueries {
  /** The query window of a fast query (in `database` if given, else its own): one tab per file, so clicking it again focuses it. */
  const windowFor = (q: FastQueryEntry, database: string | undefined, extra: Partial<QueryWindowOptions> = {}) =>
    queryWindow({
      windowId: `fq:${q.file}`,
      title: q.name,
      database: database ?? q.database,
      sql: q.sql,
      fastQuery: { file: q.file, name: q.name, anyDatabase: !q.database },
      ...extra,
    });

  return {
    async nodes(folder, node) {
      const queries = await listFastQueries(folder);
      if (node.nodeType === `${prefix}.fastQueriesRoot`) {
        if (queries.length === 0) {
          return [{ id: "fq:empty", label: "No fast queries yet — right-click → New Fast Query…", nodeType: `${prefix}.fastQueryHint`, collapsible: "none", contextValue: `${prefix}.fastQueriesRoot` }];
        }
        const groups = [...new Set(queries.map((q) => q.database ?? ""))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
        return groups.map((db) => ({
          id: `fq:db:${db}`,
          label: db || "Any database",
          nodeType: `${prefix}.fastQueryGroup`,
          collapsible: "expanded",
          icon: "$(database)",
          contextValue: `${prefix}.fastQueryGroup`,
          data: db ? { database: db } : {},
        }));
      }
      if (node.nodeType === `${prefix}.fastQueryGroup`) {
        const db = (node.data as { database?: string } | undefined)?.database ?? "";
        return queries
          .filter((q) => (q.database ?? "") === db)
          .map((q): TreeNode => {
            const { openView } = windowFor(q, undefined);
            return {
              id: `fq:${q.file}`,
              label: q.name,
              nodeType: `${prefix}.fastQuery`,
              collapsible: "none",
              icon: FAST_QUERY_ICON,
              tooltip: q.description ? `${q.description}\n${q.file}` : q.file,
              contextValue: `${prefix}.fastQuery`,
              data: { fastQueryFile: q.file, ...(db ? { database: db } : {}) },
              ...(openView ? { openView } : {}),
            };
          });
      }
      return [];
    },

    async run(connectionId, file, database) {
      const doc = await readFastQueryFile(folders.require(connectionId), file);
      const db = database || doc.database;
      return windowFor({ ...doc, file }, db, { autorun: !!db, windowId: `fq:${file}:${db ?? ""}:${Date.now()}` });
    },

    newWindow(database) {
      const sql = "-- Write the query, then ★ Save as Fast Query (Ctrl+S).\n";
      return queryWindow({ database, sql, title: "New fast query" });
    },

    async save(connectionId, doc, file) {
      const name = doc.name.trim();
      if (!name) throw new Error("Give the fast query a name.");
      if (!doc.sql.trim()) throw new Error("The query is empty.");
      const saved = await writeFastQueryFile(folders.require(connectionId), { ...doc, name }, file);
      return { file: saved, name };
    },

    async rename(connectionId, file, name) {
      if (!name.trim()) throw new Error("Give the fast query a name.");
      return renameFastQueryFile(folders.require(connectionId), file, name);
    },

    async remove(connectionId, file) {
      await deleteFastQueryFile(folders.require(connectionId), file);
    },
  };
}
