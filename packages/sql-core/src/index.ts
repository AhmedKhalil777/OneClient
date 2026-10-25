/**
 * @oneclient/sql-core — the shared base of oneClient's SQL plugins (SQL Server, PostgreSQL, …).
 *
 * A plugin brings its dialect (connection, query runner, metadata, completion) and gets the rest from here:
 * query-window ↔ results plumbing, query history and the FAST TOOLS section (fast queries for every dialect, plus
 * tools the plugin adds, like SQL Server's fakers). Each feature can be turned off (`SqlCoreOptions.features`).
 * The view-side half (query window, results panel, editor) is `@oneclient/sql-core/ui`.
 */
export { isReadOnlySql } from "./ai-tools.js";
export { type SqlCore, type SqlCoreFeatures, type SqlCoreOptions, checkDatabaseName, commandArg, createSqlCore } from "./core.js";
export type { ExecuteQuery, ExecuteQueryRequest, QueryRunSummary } from "./types.js";
export { type HistoryEntry, type HistoryStore, createHistoryStore } from "./history.js";
export { type WindowInfo, type WindowState, type WindowUpdate, createQueryViews } from "./views.js";
export { type QueryWindowFactory, type QueryWindowOptions, createQueryWindowFactory } from "./query-window.js";
export { type FastTool, type FastToolsSection, createFastToolsSection } from "./fast-tools/index.js";
export { type FolderStore, createFolderStore, findFiles, freeName, inFolder, slug } from "./fast-tools/folder.js";
export { FAST_QUERY_ICON, type FastQueries, createFastQueries } from "./fast-queries/api.js";
export { FAST_QUERY_EXT, type FastQueryDoc, readFastQuery, writeFastQuery } from "./fast-queries/file.js";
export { dataHome } from "./paths.js";
export { type Background, type BackgroundHost, createBackground, errorSummary, formatElapsed, titleOf } from "./background/manager.js";
export { type BackgroundStore, createBackgroundStore } from "./background/store.js";
export type { BackgroundResult, BackgroundResultSet, BackgroundState, BackgroundTaskDetail, BackgroundTaskInfo } from "./background/types.js";
export { type SqlSection, type SqlSections, combineSections, createBackgroundSection, createHistorySection, dayLabel, describeTask, oneLine } from "./sections.js";
export { SSH_AUTH_AGENT, SSH_AUTH_KEY, SSH_AUTH_PASSWORD, type SshConfig, type Tunnel, type TunnelTarget, checkHostKey, closeTunnel, openTunnel, sshEnabled, sshSchemaProperties, tunnelFor } from "./ssh/tunnel.js";
export type { TableEditor } from "./table-editor/api.js";
export { type Planner, PlanError, analyzePlan, createPlanner } from "./plan/api.js";
export type { PlanAccess, PlanMode, PlanNode, PlanResult } from "./plan/types.js";
export { type CsvImporter, type ImportRequest, type ImportStatus, autoMap, createCsvImporter } from "./import/import.js";
export { type CsvSample, createCsvParser, detectDelimiter, detectEncoding, parseCsv, readCsvRows, sampleCsv } from "./import/csv.js";
export { BATCH_ROWS, EditError, buildStatements, checkWhere, literal, reviewScript } from "./table-editor/sql.js";
export { type CellInput, type Change, type ColumnKind, CUT_MARKER, type CutValue, LOB_LIMIT, LOB_PREVIEW, type LoadedTable, MAX_PAGE_SIZE, PAGE_SIZE, type PageQuery, type Statement, type TableAccess, type TableColumn, type TableTarget, type WriteSession, cutValue } from "./table-editor/types.js";
