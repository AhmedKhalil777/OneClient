import type { TreeNode } from "@oneclient/plugin-api";
import type { Background } from "./background/manager.js";
import { formatElapsed } from "./background/manager.js";
import type { BackgroundTaskInfo } from "./background/types.js";
import type { HistoryEntry, HistoryStore } from "./history.js";
import type { QueryWindowFactory } from "./query-window.js";
import { summarize } from "./sql-text.js";

/**
 * A sidebar section of a SQL plugin (Fast Tools, Query History, Background Tasks): per connection one root node whose
 * children come from here. The plugin's explorer provider routes every node type of the section to `nodes`.
 */
export interface SqlSection {
  rootNodeType: string;
  /** Every node type of the section that can have children (the root included). */
  nodeTypes: string[];
  handles(nodeType: string): boolean;
  nodes(connectionId: string, node: TreeNode): Promise<TreeNode[]>;
}

/** Several sections as one: what the plugin's explorer provider is handed (`core.sections`). */
export type SqlSections = Pick<SqlSection, "nodeTypes" | "handles" | "nodes">;

export function combineSections(sections: SqlSection[]): SqlSections {
  const nodeTypes = sections.flatMap((s) => s.nodeTypes);
  return {
    nodeTypes,
    handles: (type) => nodeTypes.includes(type),
    async nodes(connectionId, node) {
      const section = sections.find((s) => s.handles(node.nodeType));
      return section ? section.nodes(connectionId, node) : [];
    },
  };
}

const two = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => `${two(new Date(t).getHours())}:${two(new Date(t).getMinutes())}`;
const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Today", "Yesterday", or "Mon 20 Oct". */
export function dayLabel(t: number, now = Date.now()): string {
  if (dayKey(t) === dayKey(now)) return "Today";
  if (dayKey(t) === dayKey(now - 86_400_000)) return "Yesterday";
  const d = new Date(t);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${d.toLocaleString("en", { month: "short" })}${d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : ""}`;
}

/** A script as one short line (see summarize). */
export const oneLine = (sql: string, max = 90): string => summarize(sql, max);

// ---- QUERY HISTORY ---------------------------------------------------------------------------------------------------

/** Entries shown in the tree; the History panel of a query window reaches all of them. */
const HISTORY_LIMIT = 300;

export function createHistorySection(prefix: string, history: HistoryStore, queryWindow: QueryWindowFactory): SqlSection {
  const root = `${prefix}.historyRoot`;
  const group = `${prefix}.historyGroup`;
  const entryType = `${prefix}.historyEntry`;

  const entryNode = (e: HistoryEntry): TreeNode => {
    const open = queryWindow({ windowId: `hist:${e.id}`, sql: e.sql, database: e.database ?? undefined, title: oneLine(e.sql, 28) });
    const detail = [e.database, clock(e.at), `${e.elapsedMs.toLocaleString()} ms`, e.status === "ok" ? `${e.rows.toLocaleString()} row${e.rows === 1 ? "" : "s"}` : e.status === "cancelled" ? "cancelled" : "failed"];
    return {
      id: `hist:${e.id}`,
      label: oneLine(e.sql),
      description: detail.filter(Boolean).join(" · "),
      tooltip: `${e.sql.length > 800 ? `${e.sql.slice(0, 800)}…` : e.sql}${e.error ? `\n\n— ${e.error}` : ""}`,
      nodeType: entryType,
      collapsible: "none",
      icon: e.status === "ok" ? "$(file-code)" : e.status === "cancelled" ? "$(stop)" : "$(close)",
      contextValue: entryType,
      data: { historyId: e.id, ...(e.database ? { database: e.database } : {}) },
      ...(open.openView ? { openView: open.openView } : {}),
    };
  };

  return {
    rootNodeType: root,
    nodeTypes: [root, group],
    handles: (type) => type === root || type === group || type === entryType,
    async nodes(connectionId, node) {
      const entries = await history.list(connectionId, { limit: HISTORY_LIMIT });
      if (node.nodeType === root) {
        if (!entries.length) return [{ id: "hist:none", label: "Nothing run yet — queries you run appear here", nodeType: `${prefix}.historyHint`, collapsible: "none", contextValue: root }];
        const days = [...new Set(entries.map((e) => dayKey(e.at)))];
        return days.map((key, i): TreeNode => {
          const inDay = entries.filter((e) => dayKey(e.at) === key);
          return { id: `hist:day:${key}`, label: dayLabel(inDay[0]!.at), description: `${inDay.length}`, nodeType: group, collapsible: i === 0 ? "expanded" : "collapsed", icon: "$(clock)", contextValue: group, data: { day: key } };
        });
      }
      if (node.nodeType === group) {
        const key = (node.data as { day?: string } | undefined)?.day;
        return entries.filter((e) => dayKey(e.at) === key).map(entryNode);
      }
      return [];
    },
  };
}

// ---- BACKGROUND TASKS --------------------------------------------------------------------------------------------------

const STATE_ICON: Record<BackgroundTaskInfo["state"], string> = { running: "$(refresh)", done: "$(results)", failed: "$(close)", cancelled: "$(stop)", interrupted: "$(bell)" };

export function describeTask(t: BackgroundTaskInfo): string {
  switch (t.state) {
    case "running":
      return `running · since ${clock(t.startedAt)}`;
    case "done":
      return `done · ${formatElapsed(t.elapsedMs)}${t.rows ? ` · ${t.rows.toLocaleString()} rows` : ""} · ${clock(t.startedAt)}`;
    case "failed":
      return `failed · ${formatElapsed(t.elapsedMs)} · ${clock(t.startedAt)}`;
    case "cancelled":
      return `cancelled · ${formatElapsed(t.elapsedMs)} · ${clock(t.startedAt)}`;
    case "interrupted":
      return `interrupted · ${clock(t.startedAt)}`;
  }
}

export function createBackgroundSection(prefix: string, background: Background): SqlSection {
  const root = `${prefix}.backgroundRoot`;
  const taskType = `${prefix}.backgroundTask`;
  return {
    rootNodeType: root,
    nodeTypes: [root],
    handles: (type) => type === root || type === taskType,
    async nodes(connectionId, node) {
      if (node.nodeType !== root) return [];
      const tasks = await background.list(connectionId);
      if (!tasks.length) return [{ id: "bg:none", label: "No background tasks — switch on ⏱ Background in a query window, then run", nodeType: `${prefix}.backgroundHint`, collapsible: "none", contextValue: root }];
      return tasks.map(
        (t): TreeNode => ({
          id: `bg:${t.id}`,
          label: t.title,
          description: describeTask(t),
          tooltip: `${t.sql.length > 800 ? `${t.sql.slice(0, 800)}…` : t.sql}${t.error ? `\n\n— ${t.error}` : ""}`,
          nodeType: taskType,
          collapsible: "none",
          icon: STATE_ICON[t.state],
          // Running tasks can be cancelled; finished ones removed — the menu items key off this.
          contextValue: t.state === "running" ? `${taskType}Running` : taskType,
          data: { backgroundId: t.id, ...(t.database ? { database: t.database } : {}) },
          openView: { viewId: `${prefix}.backgroundTask`, title: t.title.length > 30 ? `${t.title.slice(0, 29)}…` : t.title, params: { id: t.id }, icon: "$(clock)" },
        }),
      );
    },
  };
}
