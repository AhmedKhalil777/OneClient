import type { AiToolContribution, PluginContext } from "@oneclient/plugin-api";
import { AI_TOOLS_POINT } from "@oneclient/plugin-api";
import type { ToolCall, ToolDef, ToolResult } from "./types.js";

/**
 * The assistant's reach into other plugins: every tool a plugin lists under `oneclient.aiTools` (SQL queries, …) plus
 * `list_connections`, which tells the model which connections exist. Read-only tools just run; any other tool shows
 * the user what it is about to do and waits for Approve.
 */

export interface PluginToolset {
  defs: ToolDef[];
  /** Runs one of `defs`; undefined when the name is not one of them. */
  call(call: ToolCall, approve: (call: ToolCall, summary: string) => Promise<boolean>): Promise<ToolResult | undefined>;
}

const MAX_RESULT = 24_000;
const NAME_OK = /^[A-Za-z0-9_-]{1,48}$/;

export const LIST_CONNECTIONS: ToolDef = {
  name: "list_connections",
  description: "List the user's saved connections (databases, servers, …) with their ids. Call this first when a task involves a database or another service, then pass the id to that service's tools. Passwords are never included.",
  schema: { type: "object", properties: { type: { type: "string", description: "Only this connection type, e.g. postgres, mssql, mysql." } } },
};

const clip = (s: string) => (s.length > MAX_RESULT ? `${s.slice(0, MAX_RESULT)}\n… (cut at ${MAX_RESULT} characters)` : s);

/** What a plugin command returned, as text for the model. */
function render(value: unknown): { content: string; isError: boolean } {
  if (value && typeof value === "object" && "ok" in value) {
    const v = value as { ok: boolean; text?: unknown; error?: unknown };
    if (v.ok === false) return { content: clip(String(v.error ?? "The tool failed.")), isError: true };
    if (typeof v.text === "string") return { content: clip(v.text), isError: false };
  }
  return { content: clip(typeof value === "string" ? value : (JSON.stringify(value, null, 1) ?? "(no result)")), isError: false };
}

function summaryOf(tool: AiToolContribution, call: ToolCall, connectionName: string | undefined): string {
  const { sql, ...rest } = call.input as { sql?: unknown } & Record<string, unknown>;
  const where = connectionName ? ` on “${connectionName}”` : "";
  if (typeof sql === "string") return `${tool.name}${where}\n\n${sql}`;
  return `${tool.name}${where}\n\n${JSON.stringify(rest, null, 2)}`;
}

export async function loadPluginTools(context: PluginContext): Promise<PluginToolset> {
  let contributed: Array<AiToolContribution & { pluginId: string }> = [];
  try {
    contributed = await context.contributions.get<AiToolContribution>(AI_TOOLS_POINT);
  } catch {
    /* no plugin offers tools */
  }
  const tools = new Map<string, AiToolContribution>();
  for (const t of contributed) {
    if (typeof t.name === "string" && NAME_OK.test(t.name) && typeof t.command === "string" && t.name !== LIST_CONNECTIONS.name && !tools.has(t.name)) tools.set(t.name, t);
  }

  const defs: ToolDef[] = [LIST_CONNECTIONS, ...[...tools.values()].map((t) => ({ name: t.name, description: t.description, schema: (t.inputSchema as unknown as Record<string, unknown>) ?? { type: "object", properties: {} } }))];

  return {
    defs,
    async call(call, approve) {
      const done = (r: { content: string; isError: boolean }): ToolResult => ({ id: call.id, name: call.name, content: r.content, ...(r.isError ? { isError: true } : {}) });
      try {
        if (call.name === LIST_CONNECTIONS.name) {
          const wanted = typeof call.input.type === "string" ? call.input.type : "";
          const rows = (await context.connections.list())
            .filter((c) => c.pluginId !== context.pluginId && (!wanted || c.typeId === wanted))
            .map((c) => {
              const cfg = c.config as Record<string, unknown>;
              const extra = ["host", "server", "port", "database"].filter((k) => cfg[k] !== undefined && cfg[k] !== "").map((k) => `${k}=${String(cfg[k])}`);
              return `${c.id}\t${c.name}\t${c.typeId}${extra.length ? `\t${extra.join(" ")}` : ""}`;
            });
          return done({ content: rows.length ? `id\tname\ttype\tdetails\n${rows.join("\n")}` : "No connections saved yet.", isError: false });
        }
        const tool = tools.get(call.name);
        if (!tool) return undefined;
        if (!tool.readOnly) {
          let name: string | undefined;
          const id = call.input.connectionId;
          if (typeof id === "string") name = (await context.connections.list()).find((c) => c.id === id)?.name;
          if (!(await approve(call, summaryOf(tool, call, name)))) return done({ content: "The user declined this action.", isError: true });
        }
        return done(render(await context.aiTools.call(tool.command, call.input)));
      } catch (err) {
        return done({ content: err instanceof Error ? err.message : String(err), isError: true });
      }
    },
  };
}
