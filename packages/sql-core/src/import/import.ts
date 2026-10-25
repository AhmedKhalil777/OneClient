import { stat } from "node:fs/promises";
import type { CommandHandler, TreeNode } from "@oneclient/plugin-api";
import { EditError, normalizeValue, toLiteral } from "../table-editor/sql.js";
import type { Statement, TableAccess, TableColumn, TableTarget, WriteSession } from "../table-editor/types.js";
import { readCsvRows, sampleCsv } from "./csv.js";
import type { ImportRequest, ImportStatus } from "./types.js";

export type { ImportRequest, ImportStatus };

/**
 * CSV import into a table. The file is streamed (never loaded whole), every cell is validated against its column before
 * anything is sent, rows go out as multi-row INSERTs sized by bytes, and the next batch is parsed while the previous one
 * runs. All-or-nothing by default: one transaction, rolled back on the first bad row.
 */

/** Rows per INSERT: SQL Server allows 1,000 row values in one INSERT. */
const ROWS_PER_INSERT = 1000;
/** Rows per call of the data fast path (see WriteSession.fast), or this many bytes of values. */
const FAST_ROWS = 5000;
const FAST_BYTES = 2 * 1024 * 1024;
/** A statement is closed at about this many bytes of SQL, whichever comes first. */
const BYTES_PER_INSERT = 256 * 1024;
/** Statements sent per round trip. */
const STATEMENTS_PER_RUN = 4;
/** In "commit as you go" mode, a transaction ends after about this many rows. */
const COMMIT_EVERY = 10_000;

interface Job extends ImportStatus {
  cancel: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-.]+/g, "");

/** CSV header → table column, by name ignoring case, spaces, `_` and `-`; a column can be used once. */
export function autoMap(header: string[], columns: TableColumn[]): Array<string | null> {
  const used = new Set<string>();
  return header.map((h) => {
    const c = columns.find((x) => x.insertable && !used.has(x.name) && norm(x.name) === norm(h));
    if (c) used.add(c.name);
    return c?.name ?? null;
  });
}

/** One CSV cell → the column's normalized value (null = NULL); throws a message naming the column. */
function cell(raw: string, col: TableColumn, emptyAsNull: boolean): string | null {
  if (raw === "") {
    if (col.kind !== "text") {
      if (!col.nullable) throw new EditError(`"${col.name}" is empty but doesn't accept NULL.`);
      return null;
    }
    if (emptyAsNull && col.nullable) return null;
  }
  return normalizeValue(col.kind === "text" || col.kind === "json" ? raw : raw.trim(), col);
}

export interface CsvImporter {
  /** `<prefix>.importData`: preview / start / status / cancel. */
  command: CommandHandler;
  /** The import tab of a table (the file travels in the params). */
  tab(target: TableTarget, file: string): TreeNode;
}

export function createCsvImporter(prefix: string, access: TableAccess, describe: (err: unknown) => string, columnsOf: (connectionId: string, target: TableTarget) => Promise<TableColumn[]>): CsvImporter {
  const jobs = new Map<string, Job>();
  let counter = 0;

  async function run(job: Job, connectionId: string, target: TableTarget, columns: TableColumn[], req: ImportRequest, delimiter: string): Promise<void> {
    const started = Date.now();
    const targets = req.mapping.map((name) => (name ? columns.find((c) => c.name === name) : undefined));
    const used = targets.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
    const names = used.map((i) => access.quote(targets[i]!.name)).join(", ");
    const table = access.qualify(target);

    const usedColumns = used.map((i) => targets[i]!);
    let session = null as WriteSession | null;
    let fast: NonNullable<WriteSession["fast"]> | undefined;
    let inflight: Promise<void> = Promise.resolve();
    let pending: Statement[] = [];
    let tuples: string[] = [];
    let tupleBytes = 0;
    let dataRows: Array<Array<string | null>> = [];
    let dataBytes = 0;
    let sinceCommit = 0;

    const open = async () => {
      session = await access.begin(connectionId, target);
      fast = session.fast && (await session.fast.supports(usedColumns)) ? session.fast : undefined;
    };

    const closeInsert = () => {
      if (!tuples.length) return;
      pending.push({ sql: `INSERT INTO ${table} (${names}) VALUES ${tuples.join(", ")}`, expect: tuples.length });
      tuples = [];
      tupleBytes = 0;
    };
    /** Sends what is pending; the previous send finishes first, but parsing carries on while this one runs. */
    const send = async () => {
      closeInsert();
      let rows: number;
      let work: (s: WriteSession) => Promise<void>;
      if (fast && dataRows.length) {
        const batch = dataRows;
        const f = fast;
        dataRows = [];
        dataBytes = 0;
        rows = batch.length;
        work = () => f.insert(usedColumns, batch);
      } else if (pending.length) {
        const batch = pending;
        pending = [];
        rows = batch.reduce((n, s) => n + s.expect, 0);
        work = (s) => s.run(batch);
      } else return;
      await inflight;
      const s = session!;
      const running = work(s).then(() => {
        job.rows += rows;
      });
      running.catch(() => undefined); // surfaced by the next `await inflight`; never an unhandled rejection
      inflight = running;
      sinceCommit += rows;
      if (!req.allOrNothing && sinceCommit >= COMMIT_EVERY) {
        await inflight;
        await s.commit();
        job.committed = job.rows;
        await open();
        sinceCommit = 0;
      }
    };

    try {
      await open();
      let n = 0; // CSV records seen, header included
      for await (const { row, bytes } of readCsvRows(req.file, delimiter)) {
        if (job.cancel) throw new CancelError();
        n++;
        job.bytes = bytes;
        job.elapsedMs = Date.now() - started;
        if (req.header && n === 1) continue;
        const values = used.map((i) => {
          try {
            return cell(row[i] ?? "", targets[i]!, req.emptyAsNull);
          } catch (err) {
            throw new EditError(`Row ${n}: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
        if (fast) {
          dataRows.push(values);
          for (const v of values) dataBytes += v === null ? 4 : v.length + 3;
          if (dataRows.length >= FAST_ROWS || dataBytes >= FAST_BYTES) await send();
          continue;
        }
        const tuple = `(${values.map((v, k) => toLiteral(v, usedColumns[k]!, access)).join(", ")})`;
        tuples.push(tuple);
        tupleBytes += tuple.length;
        if (tuples.length >= ROWS_PER_INSERT || tupleBytes >= BYTES_PER_INSERT) closeInsert();
        if (pending.length >= STATEMENTS_PER_RUN) await send();
      }
      await send();
      await inflight;
      if (job.cancel) throw new CancelError();
      await session!.commit();
      job.committed = job.rows;
      session = null;
      job.state = "done";
    } catch (err) {
      await inflight.catch(() => undefined);
      await session?.rollback().catch(() => undefined);
      if (err instanceof CancelError) job.state = "cancelled";
      else {
        job.state = "failed";
        job.error = err instanceof EditError ? err.message : describe(err);
      }
      if (job.committed) job.error = `${job.error ?? "Cancelled"} ${job.committed.toLocaleString()} row(s) were already committed.`;
    } finally {
      job.elapsedMs = Date.now() - started;
    }
  }

  const methods: Record<string, (cid: string, p: Record<string, unknown>) => Promise<unknown>> = {
    /** The head of the file, the table's columns, and a suggested mapping. */
    async preview(cid, p) {
      const target = targetOf(p);
      const file = String(p.file ?? "");
      if (!file) throw new EditError("Choose a CSV file.");
      const sample = await sampleCsv(file, typeof p.delimiter === "string" && p.delimiter ? p.delimiter : undefined).catch((err: NodeJS.ErrnoException) => {
        throw new EditError(err.code === "ENOENT" ? `The file ${file} doesn't exist.` : `Can't read ${file}: ${err.message}`);
      });
      const columns = await columnsOf(cid, target);
      const header = p.header !== false;
      const first = sample.rows[0] ?? [];
      const width = Math.max(0, ...sample.rows.map((r) => r.length));
      const names = header ? first : Array.from({ length: width }, (_, i) => `column ${i + 1}`);
      const mapping = header ? autoMap(first, columns) : names.map((_, i) => columns.filter((c) => c.insertable)[i]?.name ?? null);
      return {
        delimiter: sample.delimiter,
        encoding: sample.encoding.label,
        size: sample.size,
        estimatedRows: Math.max(0, sample.estimatedRows - (header ? 1 : 0)),
        header: names,
        rows: sample.rows.slice(header ? 1 : 0, (header ? 1 : 0) + 12),
        mapping,
        columns: columns.filter((c) => c.insertable).map((c) => ({ name: c.name, type: c.type, kind: c.kind, nullable: c.nullable, hasDefault: c.hasDefault })),
      };
    },
    async start(cid, p) {
      const target = targetOf(p);
      const req = p.request as ImportRequest;
      if (!req?.file) throw new EditError("Choose a CSV file.");
      const columns = await columnsOf(cid, target);
      const mapped = (req.mapping ?? []).filter((m): m is string => !!m);
      if (!mapped.length) throw new EditError("Map at least one CSV column to a table column.");
      if (new Set(mapped).size !== mapped.length) throw new EditError("A table column can only be filled by one CSV column.");
      for (const name of mapped) if (!columns.some((c) => c.name === name && c.insertable)) throw new EditError(`"${name}" can't be imported into.`);
      const missing = columns.filter((c) => c.insertable && !c.nullable && !c.hasDefault && !mapped.includes(c.name));
      if (missing.length) throw new EditError(`Map a CSV column to ${missing.map((c) => `"${c.name}"`).join(", ")}: it needs a value and has no default.`);
      const size = (await stat(req.file).catch(() => null))?.size;
      if (size === undefined) throw new EditError(`The file ${req.file} doesn't exist.`);
      const sample = await sampleCsv(req.file, req.delimiter || undefined, 1);
      const job: Job = { id: `imp${++counter}`, state: "running", rows: 0, committed: 0, bytes: 0, size, elapsedMs: 0, cancel: false };
      jobs.set(job.id, job);
      if (jobs.size > 20) jobs.delete(jobs.keys().next().value!);
      void run(job, cid, target, columns, req, req.delimiter || sample.delimiter);
      return { id: job.id };
    },
    async status(_cid, p) {
      const job = jobs.get(String(p.id));
      if (!job) throw new EditError("That import is no longer known.");
      const { cancel: _c, ...status } = job;
      return status satisfies ImportStatus;
    },
    async cancel(_cid, p) {
      const job = jobs.get(String(p.id));
      if (job) job.cancel = true;
      return { ok: true };
    },
  };

  const targetOf = (p: Record<string, unknown>): TableTarget => {
    const t = { database: String(p.database ?? ""), schema: String(p.schema ?? ""), table: String(p.table ?? "") };
    if (!t.database || !t.schema || !t.table) throw new EditError("Which table?");
    return t;
  };

  return {
    command: {
      commandId: `${prefix}.importData`,
      async execute(args) {
        try {
          const { connectionId, method, params } = (args[0] ?? {}) as { connectionId?: string; method?: string; params?: Record<string, unknown> };
          if (!connectionId) throw new EditError("No connection id provided.");
          const fn = methods[String(method)];
          if (!fn) throw new EditError(`Unknown operation "${String(method)}".`);
          return { ok: true, data: await fn(connectionId, params ?? {}) };
        } catch (err) {
          return { ok: false, error: err instanceof EditError ? err.message : describe(err) };
        }
      },
    },
    tab(target, file) {
      const title = `Import into ${target.schema}.${target.table}`;
      return { id: `import:${target.database}:${target.schema}.${target.table}:${file}`, label: title, nodeType: `${prefix}.importView`, collapsible: "none", openView: { viewId: `${prefix}.importCsv`, title, params: { ...target, file }, icon: "$(add)" } };
    },
  };
}

class CancelError extends Error {}
