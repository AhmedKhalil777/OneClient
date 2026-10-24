/**
 * SQL tooling shared by the SQL plugins' views (PostgreSQL, SQL Server, …):
 *
 *   import { ResultGrid, HistoryPanel, SafeModeDialog, findRiskyStatements } from "@oneclient/editor-kit/sql";
 *   import "@oneclient/editor-kit/sql.css";
 *
 * The grid sorts, filters, selects ranges, views cells and exports (CSV, TSV, JSON, Markdown, INSERT); the history panel
 * reads the plugin's per-connection query history; safe mode asks before data-wide changes and drops.
 */
export { ResultGrid, type ResultGridProps, copyText } from "./ResultGrid.js";
export { HistoryPanel, type HistoryPanelProps, type HistoryEntry, SafeModeDialog } from "./QueryTools.js";
export { type RiskyStatement, findRiskyStatements } from "./guard.js";
export {
  type Dialect,
  type Rect,
  type ResultColumn,
  type ResultSet,
  compareValues,
  display,
  guessTables,
  pick,
  prettyValue,
  quoteIdent,
  toCsv,
  toInserts,
  toJson,
  toMarkdown,
  toTsv,
  viewOrder,
} from "./data.js";
