import type { ExecuteQuery } from "./types.js";

/** The slice of an Output channel the query log needs (`PluginContext.createOutputChannel`'s result). */
export interface QueryLogChannel {
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: string): void;
}

const oneLine = (sql: string, max = 100) => {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/**
 * Wraps a dialect's query runner so every run — success, SQL error, cancel or crash — is written to the plugin's
 * Output "Queries" channel: a one-line summary with timing, the full statement (clipped) and the server's messages as
 * expandable detail. The runner's behaviour and result are unchanged, and a failing channel never breaks a query.
 */
export function withQueryLog(run: ExecuteQuery, channel: QueryLogChannel | undefined, describe: (err: unknown) => string): ExecuteQuery {
  if (!channel) return run;
  const safe = (level: "debug" | "info" | "warn" | "error", message: string, detail?: string) => {
    try {
      channel.log(level, message, detail);
    } catch {
      /* logging must never fail a query */
    }
  };
  return async (request) => {
    const sql = request.sql.length > 4000 ? `${request.sql.slice(0, 4000)}\n… (${request.sql.length - 4000} more characters)` : request.sql;
    const where = request.database ? `[${request.database}] ` : "";
    const started = Date.now();
    try {
      const r = await run(request);
      const rows = r.resultSets.reduce((n, s) => n + s.totalRows, 0);
      const messages = r.messages.map((m) => `${m.kind}: ${m.text}`).join("\n");
      if (r.hasErrors) safe("error", `✗ ${where}${oneLine(request.sql)} — ${r.messages.find((m) => m.kind === "error")?.text ?? "the statement failed"}`, `${sql}\n\n${messages}`);
      else if (r.cancelled) safe("warn", `■ ${where}${oneLine(request.sql)} — cancelled after ${r.elapsedMs} ms`, sql);
      else safe("info", `✓ ${where}${oneLine(request.sql)} — ${r.resultSets.length} result set(s), ${rows} row(s), ${r.rowsAffected} affected, ${r.elapsedMs} ms`, messages ? `${sql}\n\n${messages}` : sql);
      return r;
    } catch (err) {
      safe("error", `✗ ${where}${oneLine(request.sql)} — ${describe(err)} (after ${Date.now() - started} ms)`, `${sql}\n\n${err instanceof Error ? (err.stack ?? "") : String(err)}`);
      throw err;
    }
  };
}
