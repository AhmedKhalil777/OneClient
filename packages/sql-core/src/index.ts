/**
 * @oneclient/sql-core — the shared base of oneClient's SQL plugins (SQL Server, PostgreSQL, …).
 *
 * A plugin brings its dialect (connection, query runner, metadata, completion) and gets the rest from here:
 * query-window ↔ results plumbing, query history and the FAST TOOLS section (fast queries for every dialect, plus
 * tools the plugin adds, like SQL Server's fakers). Each feature can be turned off (`SqlCoreOptions.features`).
 * The view-side half (query window, results panel, editor) is `@oneclient/sql-core/ui`.
 */
export { type SqlCore, type SqlCoreFeatures, type SqlCoreOptions, commandArg, createSqlCore } from "./core.js";
export type { ExecuteQuery, ExecuteQueryRequest, QueryRunSummary } from "./types.js";
export { type HistoryEntry, type HistoryStore, createHistoryStore } from "./history.js";
export { type WindowInfo, type WindowState, type WindowUpdate, createQueryViews } from "./views.js";
export { type QueryWindowFactory, type QueryWindowOptions, createQueryWindowFactory } from "./query-window.js";
export { type FastTool, type FastToolsSection, createFastToolsSection } from "./fast-tools/index.js";
export { type FolderStore, createFolderStore, findFiles, freeName, inFolder, slug } from "./fast-tools/folder.js";
export { FAST_QUERY_ICON, type FastQueries, createFastQueries } from "./fast-queries/api.js";
export { FAST_QUERY_EXT, type FastQueryDoc, readFastQuery, writeFastQuery } from "./fast-queries/file.js";
export { dataHome } from "./paths.js";
