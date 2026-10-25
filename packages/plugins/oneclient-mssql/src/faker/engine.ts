import sql from "mssql";
import { quoteIdent } from "../config.js";
import { qualified } from "../metadata.js";
import { faker, fakerEntry, seedFaker } from "./catalog.js";
import { FakerError } from "./errors.js";
import { type ChildRule, type ColumnRule, type GenerateRequest, type GenerateResult, MAX_DEPTH, MAX_ROWS, type TableRule, type TableSample } from "./rules.js";
import { type ColumnInfo, type TableInfo, tableInfo } from "./schema.js";
import { suggestRule, suggestTable, textCapacity } from "./suggest.js";

const INT_RANGE: Record<string, [number, number]> = {
  tinyint: [0, 255],
  smallint: [-32768, 32767],
  int: [-2147483648, 2147483647],
  bigint: [-9007199254740991, 9007199254740991],
};
const MAX_PARAMS = 2000; // SQL Server allows 2100 parameters per request
const SAMPLE_ROWS = 20;

interface Ctx {
  pool: sql.ConnectionPool;
  tx: sql.Transaction | null;
  database: string;
  depth: number;
  tables: GenerateResult["tables"];
  samples: TableSample[];
  /** Table metadata, fetched once per table per run. */
  info: Map<string, TableInfo>;
  /** Rows generated so far in this run (all tables) — a guard against runaway nesting. */
  total: { rows: number };
  /** Preview: keep nested children small. */
  preview: boolean;
}

interface Generated {
  columns: string[];
  rows: unknown[][];
  /** Values of the columns a child table needs (its foreign keys point at them), one per inserted row. */
  keys: Map<string, unknown[]>;
}

/** Preview stand-in for the key of a parent row that would only exist after inserting (identity values). */
class Placeholder {
  constructor(readonly text: string) {}
}

export { FakerError };

/** The mssql parameter type for a column, so values go over the wire with the column's own type. */
function sqlType(c: ColumnInfo): sql.ISqlType | (() => sql.ISqlType) {
  const len = c.maxLength === -1 ? sql.MAX : c.type.startsWith("n") ? Math.max(1, c.maxLength / 2) : Math.max(1, c.maxLength);
  switch (c.type) {
    case "tinyint":
      return sql.TinyInt;
    case "smallint":
      return sql.SmallInt;
    case "int":
      return sql.Int;
    case "bigint":
      return sql.BigInt;
    case "bit":
      return sql.Bit;
    case "decimal":
    case "numeric":
      return sql.Decimal(c.precision, c.scale);
    case "money":
      return sql.Money;
    case "smallmoney":
      return sql.SmallMoney;
    case "float":
      return sql.Float;
    case "real":
      return sql.Real;
    case "date":
      return sql.Date;
    case "datetime":
      return sql.DateTime;
    case "smalldatetime":
      return sql.SmallDateTime;
    case "datetime2":
      return sql.DateTime2(c.scale);
    case "datetimeoffset":
      return sql.DateTimeOffset(c.scale);
    case "time":
      return sql.NVarChar(16); // "hh:mm:ss" converts implicitly
    case "uniqueidentifier":
      return sql.UniqueIdentifier;
    case "char":
      return sql.Char(len as number);
    case "nchar":
      return sql.NChar(len as number);
    case "varchar":
      return sql.VarChar(len);
    case "text":
      return sql.Text;
    case "ntext":
      return sql.NText;
    case "binary":
    case "varbinary":
      return sql.VarBinary(len);
    default:
      return sql.NVarChar(len);
  }
}

const isText = (c: ColumnInfo) => ["char", "varchar", "nchar", "nvarchar", "text", "ntext"].includes(c.type);
const isDate = (c: ColumnInfo) => ["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset"].includes(c.type);
const isNumber = (c: ColumnInfo) => c.type in INT_RANGE || ["decimal", "numeric", "money", "smallmoney", "float", "real"].includes(c.type);

/** Text that fits `cap` characters: a code for tiny columns, words for small ones, a sentence otherwise. */
function fittingText(cap: number): string {
  if (cap <= 12) return faker.string.alphanumeric(Math.max(1, Math.min(cap, 8)));
  if (cap <= 40) return faker.lorem.words({ min: 1, max: 3 });
  if (cap <= 120) return faker.lorem.sentence({ min: 3, max: 8 });
  return faker.lorem.paragraph();
}

/** Coerces a generated value to what the column takes (type, length, numeric range). */
function fit(value: unknown, c: ColumnInfo): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Placeholder) return value;
  if (isText(c)) {
    const s = value instanceof Date ? value.toISOString() : String(value);
    const cap = textCapacity(c);
    return s.length > cap ? s.slice(0, cap).trimEnd() || s.slice(0, cap) : s;
  }
  if (isDate(c)) {
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) throw new FakerError(`"${String(value)}" is not a date (column ${c.name}).`);
    return c.type === "smalldatetime" || c.type === "datetime" ? (d.getFullYear() < 1900 ? new Date("1900-01-01") : d) : d;
  }
  if (c.type === "bit") return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
  if (isNumber(c)) {
    const n = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.+-eE]/g, ""));
    if (!Number.isFinite(n)) throw new FakerError(`"${String(value)}" is not a number (column ${c.name}).`);
    const range = INT_RANGE[c.type];
    if (range) return Math.min(range[1], Math.max(range[0], Math.round(n)));
    if (c.type === "decimal" || c.type === "numeric") {
      const limit = 10 ** (c.precision - c.scale) - 10 ** -c.scale;
      return Math.max(-limit, Math.min(limit, Number(n.toFixed(c.scale))));
    }
    return n;
  }
  if (c.type === "binary" || c.type === "varbinary") return Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return value;
}

/** One value for one column of row `i`. `pool` holds the candidate key values of a foreign key column. */
function generate(rule: ColumnRule, c: ColumnInfo, i: number, pool: unknown[] | undefined): unknown {
  if (c.nullable && rule.nullPercent && faker.number.int({ min: 1, max: 100 }) <= rule.nullPercent) return null;
  switch (rule.kind) {
    case "null":
      return null;
    case "constant":
      return rule.value ?? "";
    case "faker": {
      const entry = fakerEntry(rule.fakerId);
      if (!entry) throw new FakerError(`Unknown generator "${rule.fakerId ?? ""}" for column ${c.name}.`);
      return entry.make();
    }
    case "integer":
      return faker.number.int({ min: Math.ceil(rule.min ?? 0), max: Math.floor(rule.max ?? 1000) });
    case "decimal":
      return faker.number.float({ min: rule.min ?? 0, max: rule.max ?? 1000, fractionDigits: Math.max(0, Math.min(rule.decimals ?? 2, 8)) });
    case "date": {
      const from = rule.from ? new Date(rule.from) : new Date(Date.now() - 365 * 86_400_000);
      const to = rule.to ? new Date(rule.to) : new Date();
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new FakerError(`Column ${c.name}: the date range is invalid.`);
      return faker.date.between({ from, to: to < from ? from : to });
    }
    case "boolean":
      return faker.datatype.boolean();
    case "guid":
      return faker.string.uuid();
    case "sequence":
      return (rule.start ?? 1) + i * (rule.step ?? 1);
    case "pick": {
      const values = (rule.value ?? "").split(/\r?\n|,/).map((v) => v.trim()).filter((v) => v !== "");
      if (values.length === 0) throw new FakerError(`Column ${c.name}: "Pick from list" needs at least one value.`);
      return faker.helpers.arrayElement(values);
    }
    case "fk-existing":
    case "fk-new":
      if (!pool || pool.length === 0) return null;
      // New parents: spread children evenly so every parent gets some; existing rows: random.
      return rule.kind === "fk-new" ? pool[i % pool.length] : faker.helpers.arrayElement(pool);
    case "text":
    default:
      if (c.type === "time") return `${String(faker.number.int({ min: 0, max: 23 })).padStart(2, "0")}:${String(faker.number.int({ min: 0, max: 59 })).padStart(2, "0")}:00`;
      if (c.type === "binary" || c.type === "varbinary") return Buffer.from(faker.string.hexadecimal({ length: 16, prefix: "" }), "hex");
      if (isNumber(c)) return faker.number.int({ min: 0, max: 1000 });
      if (isDate(c)) return faker.date.past();
      if (c.type === "uniqueidentifier") return faker.string.uuid();
      return fittingText(textCapacity(c));
  }
}

async function infoOf(ctx: Ctx, schema: string, table: string): Promise<TableInfo> {
  const key = `${schema}.${table}`.toLowerCase();
  let info = ctx.info.get(key);
  if (!info) {
    info = await tableInfo(ctx.pool, ctx.database, schema, table);
    ctx.info.set(key, info);
  }
  return info;
}

const request = (ctx: Ctx) => (ctx.tx ? new sql.Request(ctx.tx) : ctx.pool.request());

/** Generates `count` rows for `rule` (and, first, any parent rows its "new" foreign keys need); inserts them when `ctx.tx` is set. */
async function generateTable(ctx: Ctx, rule: TableRule, count: number, want: string[], forced?: Map<string, unknown[]>, relation = ""): Promise<Generated> {
  if (ctx.depth > MAX_DEPTH) throw new FakerError(`The faker nests more than ${MAX_DEPTH} levels deep (parents / children) — flatten it a little.`);
  ctx.total.rows += count;
  if (ctx.total.rows > MAX_ROWS) throw new FakerError(`That would generate more than ${MAX_ROWS.toLocaleString()} rows in one run — lower the counts or the rows per parent.`);
  const info = await infoOf(ctx, rule.schema, rule.table);

  // Nested children: which column of this table each child's foreign key points at (so the INSERT returns it).
  const children: Array<{ child: ChildRule; refColumn: string }> = [];
  for (const child of rule.children ?? []) {
    const childInfo = await infoOf(ctx, child.schema, child.table);
    const col = childInfo.columns.find((c) => c.name === child.via);
    if (!col) throw new FakerError(`${child.schema}.${child.table} has no column "${child.via}".`);
    if (!col.fk || col.fk.schema.toLowerCase() !== info.schema.toLowerCase() || col.fk.table.toLowerCase() !== info.table.toLowerCase()) {
      throw new FakerError(`${child.schema}.${child.table}.${child.via} is not a foreign key to ${info.schema}.${info.table}.`);
    }
    children.push({ child, refColumn: col.fk.column });
  }
  want = [...new Set([...want, ...children.map((c) => c.refColumn)])];
  const object = qualified(ctx.database, info.schema, info.table);
  const ruleFor = (c: ColumnInfo): ColumnRule => rule.columns.find((r) => r.column === c.name) ?? suggestRule(c);

  // Which columns go into the INSERT.
  const active: Array<{ c: ColumnInfo; r: ColumnRule }> = [];
  for (const c of info.columns) {
    const r = ruleFor(c);
    if (c.identity || c.computed) continue;
    if (forced?.has(c.name)) {
      // Set by the parent row (a nested child's foreign key).
      active.push({ c, r: { column: c.name, kind: "constant" } });
      continue;
    }
    if (r.kind === "skip") {
      if (!c.nullable && !c.hasDefault) throw new FakerError(`${info.schema}.${info.table}.${c.name} is required (NOT NULL, no default) — choose a generator for it.`);
      continue;
    }
    if (c.unsupported && r.kind !== "null") throw new FakerError(`${info.schema}.${info.table}.${c.name} has type ${c.type}, which the generator can't produce — set it to Skip or NULL.`);
    if (r.kind === "null" && !c.nullable) throw new FakerError(`${info.schema}.${info.table}.${c.name} is NOT NULL — it can't be set to NULL.`);
    active.push({ c, r });
  }

  // Foreign keys: candidate values from existing rows, or from parent rows generated first.
  const pools = new Map<string, unknown[]>();
  for (const { c, r } of active) {
    if (forced?.has(c.name)) continue;
    if (!c.fk || (r.kind !== "fk-existing" && r.kind !== "fk-new")) continue;
    const refObject = qualified(ctx.database, c.fk.schema, c.fk.table);
    if (r.kind === "fk-existing") {
      const res = await request(ctx).query<{ v: unknown }>(`SELECT TOP (5000) ${quoteIdent(c.fk.column)} AS v FROM ${refObject} ORDER BY ${quoteIdent(c.fk.column)}`);
      const values = res.recordset.map((x) => x.v);
      if (values.length === 0 && !c.nullable) {
        throw new FakerError(`${c.fk.schema}.${c.fk.table} has no rows for ${c.name} to point at — choose "Create new rows" for this foreign key.`);
      }
      pools.set(c.name, values);
    } else {
      const parentRule = r.parent ?? suggestTable(await infoOf(ctx, c.fk.schema, c.fk.table));
      if (parentRule.schema.toLowerCase() === info.schema.toLowerCase() && parentRule.table.toLowerCase() === info.table.toLowerCase()) {
        throw new FakerError(`${c.name} references its own table — use "existing rows" for self-references.`);
      }
      const parentCount = Math.max(1, Math.min(MAX_ROWS, Math.round(r.parentCount ?? Math.ceil(count / 3))));
      const parent = await generateTable({ ...ctx, depth: ctx.depth + 1 }, parentRule, parentCount, [c.fk.column], undefined, `parent rows for ${info.table}.${c.name}`);
      pools.set(c.name, parent.keys.get(c.fk.column) ?? []);
    }
  }

  // Values, row by row, keeping unique columns unique.
  const seen = new Map<string, Set<string>>();
  const rows: unknown[][] = [];
  for (let i = 0; i < count; i++) {
    const row: unknown[] = [];
    for (const { c, r } of active) {
      const given = forced?.get(c.name);
      if (given) {
        row.push(given[i] ?? null);
        continue;
      }
      let v = fit(generate(r, c, i, pools.get(c.name)), c);
      if (c.unique && v !== null && r.kind !== "sequence" && r.kind !== "guid") {
        const set = seen.get(c.name) ?? new Set<string>();
        seen.set(c.name, set);
        let tries = 0;
        while (set.has(String(v)) && tries++ < 25) v = fit(generate(r, c, i, pools.get(c.name)), c);
        if (set.has(String(v))) {
          if (typeof v === "string") v = fit(`${v.slice(0, Math.max(0, textCapacity(c) - String(i).length - 1))}-${i}`, c);
          else if (typeof v === "number") while (set.has(String(v))) v = (v as number) + 1;
        }
        set.add(String(v));
      }
      row.push(v);
    }
    rows.push(row);
  }

  const columns = active.map((a) => a.c.name);
  const keys = new Map<string, unknown[]>();

  if (ctx.tx) {
    // Batched, parameterised INSERTs; OUTPUT returns the keys children need (identity values included).
    const outputCols = want.filter((w) => info.columns.some((c) => c.name === w));
    const perStatement = Math.max(1, Math.min(1000, Math.floor(MAX_PARAMS / Math.max(1, columns.length))));
    for (const w of outputCols) keys.set(w, []);
    for (let start = 0; start < rows.length; start += perStatement) {
      const chunk = rows.slice(start, start + perStatement);
      const req = request(ctx);
      const values = chunk.map((row, ri) => {
        const names = row.map((v, ci) => {
          const p = `p${ri}_${ci}`;
          req.input(p, sqlType(active[ci]!.c), v);
          return `@${p}`;
        });
        return `(${names.join(", ")})`;
      });
      const output = outputCols.length ? ` OUTPUT ${outputCols.map((w) => `INSERTED.${quoteIdent(w)}`).join(", ")}` : "";
      const target = columns.length ? `(${columns.map(quoteIdent).join(", ")})` : "";
      const body = columns.length ? `VALUES ${values.join(", ")}` : "DEFAULT VALUES";
      if (!columns.length) {
        // Every column has a default/identity: insert one DEFAULT VALUES row per wanted row.
        for (let k = 0; k < chunk.length; k++) {
          const one = await request(ctx).query(`INSERT INTO ${object}${output} DEFAULT VALUES`);
          for (const w of outputCols) keys.get(w)!.push((one.recordset?.[0] as Record<string, unknown> | undefined)?.[w]);
        }
        continue;
      }
      const res = await req.query(`INSERT INTO ${object} ${target}${output} ${body}`);
      for (const rec of (res.recordset ?? []) as Array<Record<string, unknown>>) for (const w of outputCols) keys.get(w)!.push(rec[w]);
    }
  } else {
    // Preview: keys of new parents are only known after inserting; show what we can.
    for (const w of want) {
      const ci = columns.indexOf(w);
      const col = info.columns.find((c) => c.name === w);
      keys.set(w, ci >= 0 ? rows.map((r) => r[ci]) : rows.map((_, i) => (col?.identity ? new Placeholder(`‹new ${info.table} #${i + 1}›`) : null)));
    }
  }

  ctx.tables.push({ schema: info.schema, table: info.table, rows: rows.length });

  // A few rows for the preview grid — with the keys other tables point at (e.g. the new identity id) in front.
  const keyColumns = want.filter((w) => !columns.includes(w));
  ctx.samples.push({
    schema: info.schema,
    table: info.table,
    rows: rows.length,
    depth: ctx.depth,
    relation,
    columns: [...keyColumns, ...columns],
    sample: rows.slice(0, SAMPLE_ROWS).map((row, i) => [...keyColumns.map((k) => keys.get(k)?.[i] ?? null), ...row].map(displayValue)),
  });

  // Then each parent row's children: min–max rows per parent, their foreign key set to that parent.
  for (const { child, refColumn } of children) {
    const parentKeys = keys.get(refColumn) ?? [];
    const lo = Math.max(0, Math.floor(Math.min(child.min, child.max)));
    const hi = Math.max(lo, Math.floor(Math.max(child.min, child.max)));
    const expanded: unknown[] = [];
    for (const key of parentKeys) {
      const n = faker.number.int({ min: lo, max: hi });
      for (let k = 0; k < n; k++) expanded.push(key);
    }
    const limited = ctx.preview ? expanded.slice(0, 200) : expanded;
    if (limited.length === 0) continue;
    await generateTable({ ...ctx, depth: ctx.depth + 1 }, child, limited.length, [], new Map([[child.via, limited]]), `${lo === hi ? lo : `${lo}–${hi}`} per ${info.table} row (via ${child.via})`);
  }
  return { columns, rows, keys };
}

function displayValue(v: unknown): unknown {
  if (v instanceof Placeholder) return v.text;
  if (v instanceof Date) return v.toISOString().replace("T", " ").replace(/\.000Z$|Z$/, "");
  if (Buffer.isBuffer(v)) return `0x${v.toString("hex").toUpperCase()}`;
  return v;
}

/**
 * Generates fake rows for a table — and, for foreign keys set to "Create new rows", for the referenced tables first —
 * and inserts everything in one transaction (all or nothing). With `insert: false` nothing is written: a preview.
 */
export async function runFaker(pool: sql.ConnectionPool, req: GenerateRequest, insert: boolean): Promise<GenerateResult> {
  const started = Date.now();
  const count = Math.max(1, Math.min(MAX_ROWS, Math.round(insert ? req.count : Math.min(req.count, SAMPLE_ROWS))));
  seedFaker(req.seed);
  const ctx: Ctx = { pool, tx: null, database: req.database, depth: 0, tables: [], info: new Map(), total: { rows: 0 }, preview: !insert, samples: [] };
  let main: Generated;
  if (insert) {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    ctx.tx = tx;
    try {
      main = await generateTable(ctx, req.rule, count, []);
      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        /* the transaction may already be gone */
      }
      throw err;
    }
  } else {
    main = await generateTable(ctx, req.rule, count, []);
  }
  return {
    tables: ctx.tables,
    sample: { columns: main.columns, rows: main.rows.slice(0, SAMPLE_ROWS).map((r) => r.map(displayValue)) },
    samples: ctx.samples,
    ms: Date.now() - started,
  };
}
