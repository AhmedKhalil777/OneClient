import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { ChildRule, ColumnRule, GenerateResult, GeneratorKind, TableRule, TableSample } from "../src/faker/rules.js";
import type { ColumnInfo, TableInfo } from "../src/faker/schema.js";

interface CatalogEntry {
  id: string;
  label: string;
  group: string;
  produces: "string" | "number" | "date" | "boolean";
}
interface Loaded {
  folder: string | null;
  database?: string;
  target?: { server: string; login: string };
  databases?: string[];
  tables?: string[];
  info?: TableInfo;
  suggested?: TableRule;
  rule?: TableRule;
  faker?: { file: string; name: string; count: number; seed: number | null; database: string | null } | null;
  catalog: CatalogEntry[];
}
interface FakerDoc {
  name: string;
  database?: string;
  count: number;
  seed?: number;
  rule: TableRule;
}
type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

const params = new URLSearchParams(location.search);
const connectionId = params.get("connectionId") ?? "";

async function api<T>(method: string, p: Record<string, unknown>): Promise<Reply<T>> {
  try {
    return (await window.oneclientView.invokeCommand("mssql.faker", [{ connectionId, method, params: p }])) as Reply<T>;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const TEXT = new Set(["char", "varchar", "nchar", "nvarchar", "text", "ntext"]);
const NUMBER = new Set(["int", "bigint", "smallint", "tinyint", "decimal", "numeric", "money", "smallmoney", "float", "real"]);
const DATE = new Set(["date", "datetime", "datetime2", "smalldatetime", "datetimeoffset"]);

function typeLabel(c: ColumnInfo): string {
  if (["varchar", "char", "varbinary", "binary"].includes(c.type)) return `${c.type}(${c.maxLength === -1 ? "max" : c.maxLength})`;
  if (["nvarchar", "nchar"].includes(c.type)) return `${c.type}(${c.maxLength === -1 ? "max" : c.maxLength / 2})`;
  if (["decimal", "numeric"].includes(c.type)) return `${c.type}(${c.precision},${c.scale})`;
  return c.type;
}

/** Basic generators that make sense for a column of this type. */
function basicKinds(c: ColumnInfo): Array<[GeneratorKind, string]> {
  const out: Array<[GeneratorKind, string]> = [["skip", c.hasDefault ? "Skip (use default)" : "Skip"]];
  if (c.nullable) out.push(["null", "NULL"]);
  if (c.fk) out.push(["fk-existing", `Existing rows of ${c.fk.table}`], ["fk-new", `Create new rows in ${c.fk.table}`]);
  out.push(["constant", "Constant"], ["pick", "Pick from list"]);
  if (NUMBER.has(c.type)) out.push(["sequence", "Sequence"], ["integer", "Integer range"], ["decimal", "Decimal range"]);
  if (DATE.has(c.type)) out.push(["date", "Date range"]);
  if (c.type === "bit") out.push(["boolean", "True / false"]);
  if (c.type === "uniqueidentifier" || TEXT.has(c.type)) out.push(["guid", "GUID"]);
  if (TEXT.has(c.type)) out.push(["sequence", "Sequence (as text)"], ["integer", "Number (as text)"]);
  out.push(["text", "Random value that fits"]);
  return out;
}

const fakerFits = (c: ColumnInfo, e: CatalogEntry) => TEXT.has(c.type) || (NUMBER.has(c.type) && e.produces === "number") || (DATE.has(c.type) && e.produces === "date");
const valueOf = (r: ColumnRule) => (r.kind === "faker" ? `faker:${r.fakerId ?? ""}` : r.kind);
const same = (a: { schema: string; table: string }, b: { schema: string; table: string }) => a.schema.toLowerCase() === b.schema.toLowerCase() && a.table.toLowerCase() === b.table.toLowerCase();

/** Fetches table metadata once per table for the whole editor. */
function useTableInfo(database: string) {
  const [cache, setCache] = useState<Record<string, { info: TableInfo; suggested: TableRule } | string>>({});
  const get = useCallback(
    (schema: string, table: string) => {
      const key = `${database}|${schema}.${table}`.toLowerCase();
      if (cache[key]) return;
      setCache((c) => ({ ...c, [key]: "loading" }));
      void api<{ info: TableInfo; suggested: TableRule }>("table", { database, schema, table }).then((r) => setCache((c) => ({ ...c, [key]: r.ok ? r.data : r.error })));
    },
    [cache, database],
  );
  // Keyed by database too: switching the target database must not show the previous database's columns.
  const read = (schema: string, table: string) => cache[`${database}|${schema}.${table}`.toLowerCase()];
  return { get, read };
}
type InfoStore = ReturnType<typeof useTableInfo>;

/** The per-column options of the chosen generator. */
function Options({ r, c, set }: { r: ColumnRule; c: ColumnInfo; set: (patch: Partial<ColumnRule>) => void }) {
  const num = (key: "min" | "max" | "decimals" | "start" | "step" | "parentCount", placeholder: string, width = 70) => (
    <input className="fk-in" type="number" style={{ width }} placeholder={placeholder} value={r[key] ?? ""} onChange={(e) => set({ [key]: e.target.value === "" ? undefined : Number(e.target.value) })} />
  );
  switch (r.kind) {
    case "constant":
      return <input className="fk-in" placeholder="value" value={r.value ?? ""} onChange={(e) => set({ value: e.target.value })} />;
    case "pick":
      return <input className="fk-in wide" placeholder="a, b, c" value={r.value ?? ""} onChange={(e) => set({ value: e.target.value })} title="Comma-separated values" />;
    case "integer":
      return <>{num("min", "min")} – {num("max", "max")}</>;
    case "decimal":
      return <>{num("min", "min")} – {num("max", "max")} {num("decimals", "dp", 50)}</>;
    case "sequence":
      return <>from {num("start", "1")} step {num("step", "1", 50)}</>;
    case "date":
      return (
        <>
          <input className="fk-in" type="date" value={r.from ?? ""} onChange={(e) => set({ from: e.target.value })} /> –{" "}
          <input className="fk-in" type="date" value={r.to ?? ""} onChange={(e) => set({ to: e.target.value })} />
        </>
      );
    case "fk-new":
      return <>{num("parentCount", "auto")} new {c.fk?.table} rows</>;
    case "fk-existing":
      return <span className="fk-dim">random existing {c.fk?.table}.{c.fk?.column}</span>;
    default:
      return null;
  }
}

/**
 * One table of the faker: its columns → generators, then its nested children ("for each row, create 1–5 orders").
 * Recurses for children and for "Create new rows" foreign-key parents.
 */
function TableEditor({ info, rule, suggested, onChange, catalog, depth, store, fromParent }: { info: TableInfo; rule: TableRule; suggested?: TableRule | undefined; onChange: (r: TableRule) => void; catalog: CatalogEntry[]; depth: number; store: InfoStore; fromParent?: string }) {
  const [openParents, setOpenParents] = useState<Set<string>>(new Set());
  // Columns the faker doesn't mention get the automatic suggestion (exactly what the engine does).
  const ruleOf = (c: ColumnInfo): ColumnRule => rule.columns.find((x) => x.column === c.name) ?? suggested?.columns.find((x) => x.column === c.name) ?? { column: c.name, kind: "skip" };
  const setRule = (c: ColumnInfo, next: ColumnRule) => {
    const order = info.columns.map((x) => x.name);
    onChange({ ...rule, columns: [...rule.columns.filter((x) => x.column !== c.name), next].sort((a, b) => order.indexOf(a.column) - order.indexOf(b.column)) });
  };
  const children = rule.children ?? [];
  const setChildren = (next: ChildRule[]) => onChange({ ...rule, children: next });
  const available = info.referencedBy.filter((r) => !children.some((c) => same(c, r) && c.via === r.column));

  useEffect(() => {
    for (const c of children) store.get(c.schema, c.table);
  }, [children, store]);

  return (
    <div className="fk-tableedit">
      <table className="fk-table">
        <thead>
          <tr>
            <th>Column</th>
            <th>Type</th>
            <th>Generator</th>
            <th>Options</th>
            <th title="Share of rows that get NULL">NULL %</th>
          </tr>
        </thead>
        <tbody>
          {info.columns.map((c) => {
            const r = ruleOf(c);
            const fixed = c.identity || c.computed;
            const isFromParent = c.name === fromParent;
            const parentInfo = c.fk ? store.read(c.fk.schema, c.fk.table) : undefined;
            const expanded = openParents.has(c.name) && r.kind === "fk-new";
            return (
              <Fragment key={c.name}>
                <tr className={fixed || isFromParent ? "fk-fixed" : ""}>
                  <td className="fk-col">
                    {c.name}
                    {c.primaryKey && <span className="fk-badge">PK</span>}
                    {c.fk && <span className="fk-badge fk" title={`→ ${c.fk.schema}.${c.fk.table}(${c.fk.column})`}>FK</span>}
                    {c.unique && !c.primaryKey && <span className="fk-badge">UQ</span>}
                    {!c.nullable && !c.hasDefault && !fixed && !isFromParent && <span className="fk-req" title="Required">*</span>}
                  </td>
                  <td className="fk-dim">{typeLabel(c)}</td>
                  <td>
                    {fixed ? (
                      <span className="fk-dim">{c.identity ? "identity (automatic)" : "computed (automatic)"}</span>
                    ) : isFromParent ? (
                      <span className="fk-dim">← the parent row</span>
                    ) : (
                      <select
                        className="fk-sel"
                        value={valueOf(r)}
                        onChange={(e) => {
                          const v = e.target.value;
                          const next: ColumnRule = v.startsWith("faker:") ? { column: c.name, kind: "faker", fakerId: v.slice(6) } : { column: c.name, kind: v as GeneratorKind };
                          if (r.nullPercent !== undefined) next.nullPercent = r.nullPercent;
                          if (next.kind === "fk-new" && c.fk) {
                            setOpenParents((o) => new Set(o).add(c.name));
                            store.get(c.fk.schema, c.fk.table);
                          }
                          setRule(c, next);
                        }}
                      >
                        <optgroup label="Basic">
                          {basicKinds(c).map(([k, label]) => (
                            <option key={k + label} value={k}>
                              {label}
                            </option>
                          ))}
                        </optgroup>
                        {[...new Set(catalog.filter((e) => fakerFits(c, e)).map((e) => e.group))].map((g) => (
                          <optgroup key={g} label={g}>
                            {catalog
                              .filter((e) => e.group === g && fakerFits(c, e))
                              .map((e) => (
                                <option key={e.id} value={`faker:${e.id}`}>
                                  {e.label}
                                </option>
                              ))}
                          </optgroup>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="fk-opts">
                    {!fixed && !isFromParent && <Options r={r} c={c} set={(patch) => setRule(c, { ...r, ...patch })} />}
                    {r.kind === "fk-new" && c.fk && !isFromParent && (
                      <button
                        className="fk-link"
                        onClick={() => {
                          setOpenParents((o) => {
                            const n = new Set(o);
                            if (n.has(c.name)) n.delete(c.name);
                            else n.add(c.name);
                            return n;
                          });
                          store.get(c.fk!.schema, c.fk!.table);
                        }}
                      >
                        {expanded ? "▾" : "▸"} configure {c.fk.table}
                      </button>
                    )}
                  </td>
                  <td>
                    {c.nullable && !fixed && !isFromParent && r.kind !== "null" && r.kind !== "skip" && (
                      <input className="fk-in" type="number" min={0} max={100} style={{ width: 54 }} value={r.nullPercent ?? 0} onChange={(e) => setRule(c, { ...r, nullPercent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
                    )}
                  </td>
                </tr>
                {expanded && c.fk && (
                  <tr className="fk-nested">
                    <td colSpan={5}>
                      {typeof parentInfo === "string" ? (
                        parentInfo === "loading" ? <div className="fk-dim">Loading {c.fk.table}…</div> : <div className="fk-err">{parentInfo}</div>
                      ) : !parentInfo ? null : depth >= 4 ? (
                        <div className="fk-dim">Too deep — use “Existing rows” further down.</div>
                      ) : (
                        <div className="fk-parent">
                          <div className="fk-parent-title">
                            New parent rows in {parentInfo.info.schema}.{parentInfo.info.table}
                            <button className="fk-link" onClick={() => setRule(c, { ...r, parent: parentInfo.suggested })}>
                              reset
                            </button>
                          </div>
                          <TableEditor info={parentInfo.info} rule={r.parent ?? parentInfo.suggested} suggested={parentInfo.suggested} onChange={(parent) => setRule(c, { ...r, parent })} catalog={catalog} depth={depth + 1} store={store} />
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {/* Nested child rows: tables referencing this one. */}
      <div className="fk-children">
        {children.map((child, i) => {
          const ci = store.read(child.schema, child.table);
          const update = (patch: Partial<ChildRule>) => setChildren(children.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <div className="fk-child" key={`${child.schema}.${child.table}.${child.via}`}>
              <div className="fk-child-title">
                <span>
                  ↳ for each {info.table} row, create
                  <input className="fk-in" type="number" min={0} style={{ width: 54 }} value={child.min} onChange={(e) => update({ min: Math.max(0, Number(e.target.value) || 0) })} />
                  to
                  <input className="fk-in" type="number" min={0} style={{ width: 54 }} value={child.max} onChange={(e) => update({ max: Math.max(0, Number(e.target.value) || 0) })} />
                  rows in <strong>{child.schema}.{child.table}</strong> <span className="fk-dim">(via {child.via})</span>
                </span>
                <button className="fk-link" onClick={() => setChildren(children.filter((_, j) => j !== i))} title="Remove these nested rows">
                  remove
                </button>
              </div>
              {typeof ci === "string" ? (
                ci === "loading" ? <div className="fk-dim">Loading…</div> : <div className="fk-err">{ci}</div>
              ) : !ci ? null : depth >= 4 ? (
                <div className="fk-dim">Too deep.</div>
              ) : (
                <TableEditor info={ci.info} rule={child} suggested={ci.suggested} onChange={(next) => update({ ...next, via: child.via, min: child.min, max: child.max })} catalog={catalog} depth={depth + 1} store={store} fromParent={child.via} />
              )}
            </div>
          );
        })}
        {available.length > 0 && depth < 4 && (
          <select
            className="fk-sel fk-add"
            value=""
            onChange={(e) => {
              const ref = available.find((r) => `${r.schema}.${r.table}.${r.column}` === e.target.value);
              if (!ref) return;
              store.get(ref.schema, ref.table);
              // Columns start empty: the engine suggests them; the editor fills them in once the table's info arrives.
              setChildren([...children, { schema: ref.schema, table: ref.table, via: ref.column, min: 1, max: 3, columns: [] }]);
            }}
          >
            <option value="">+ Add nested rows for each {info.table}…</option>
            {available.map((r) => (
              <option key={`${r.schema}.${r.table}.${r.column}`} value={`${r.schema}.${r.table}.${r.column}`}>
                {r.schema}.{r.table} (via {r.column})
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

/** Fake Data tab: configure a faker (a *.faker.json file in the connection's Fast Tools folder), preview it, insert rows. */
export function Faker() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [rule, setRule] = useState<TableRule | null>(null);
  const [name, setName] = useState("");
  const [count, setCount] = useState(100);
  const [seed, setSeed] = useState("");
  const [anyDatabase, setAnyDatabase] = useState(false);
  const [file, setFile] = useState(params.get("file") ?? "");
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [preview, setPreview] = useState<GenerateResult | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [inserted, setInserted] = useState(false);
  const [tab, setTab] = useState<"design" | "json">("design");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const store = useTableInfo(loaded?.database ?? "");

  const load = useCallback(async (p: Record<string, unknown>) => {
    const r = await api<Loaded>("load", p);
    if (!r.ok) return setError(r.error);
    setError("");
    setLoaded(r.data);
    if (r.data.rule && r.data.info) {
      setRule(r.data.rule);
      const n = r.data.faker?.name ?? `${r.data.info.table} faker`;
      const c = r.data.faker?.count ?? 100;
      const s = r.data.faker?.seed != null ? String(r.data.faker.seed) : "";
      const any = Boolean(r.data.faker && r.data.faker.database === null);
      setName(n);
      setCount(c);
      setSeed(s);
      setAnyDatabase(any);
      setSavedSnapshot(r.data.faker ? JSON.stringify({ rule: r.data.rule, name: n, count: c, seed: s, any }) : "");
    }
  }, []);

  useEffect(() => {
    void load({ file: params.get("file") ?? undefined, database: params.get("database") ?? undefined, schema: params.get("schema") ?? undefined, table: params.get("table") ?? undefined });
  }, [load]);

  const snapshot = useMemo(() => JSON.stringify({ rule, name, count, seed, any: anyDatabase }), [rule, name, count, seed, anyDatabase]);
  const dirty = Boolean(rule) && snapshot !== savedSnapshot;
  useEffect(() => window.oneclientView.setDirty(dirty && Boolean(file)), [dirty, file]);

  if (error) return <div className="fk-page"><div className="fk-message err">{error}</div></div>;
  if (!loaded) return <div className="fk-page"><div className="fk-message">Loading…</div></div>;

  // New faker: choose the database, then the table.
  if (!loaded.database || !loaded.info || !rule) {
    return (
      <div className="fk-page">
        <div className="fk-picker">
          <h3>New faker</h3>
          {!loaded.folder && <p className="fk-message err">No Fast Tools folder is attached to this connection yet — you can try things out, but to save, right-click the connection in FAST TOOLS → Attach Fast Tools Folder….</p>}
          {!loaded.database ? (
            <>
              <p className="fk-dim">Which database?</p>
              <select className="fk-sel" defaultValue="" onChange={(e) => e.target.value && void load({ database: e.target.value })}>
                <option value="" disabled>
                  Choose a database…
                </option>
                {(loaded.databases ?? []).map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </>
          ) : (
            <>
              <p className="fk-dim">Which table in {loaded.database} should it fill? (You can add nested tables, like a customer's orders, next.)</p>
              <select
                className="fk-sel"
                defaultValue=""
                onChange={(e) => {
                  const [schema, ...rest] = e.target.value.split(".");
                  if (schema) void load({ database: loaded.database, schema, table: rest.join(".") });
                }}
              >
                <option value="" disabled>
                  Choose a table…
                </option>
                {(loaded.tables ?? []).map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </>
          )}
        </div>
      </div>
    );
  }

  const database = loaded.database;
  const request = (r: TableRule = rule) => ({ database, rule: r, count, name, anyDatabase, ...(seed.trim() ? { seed: Number(seed) } : {}) });

  const switchDatabase = async (next: string) => {
    if (next === database) return;
    const r = await api<{ info: TableInfo; suggested: TableRule }>("table", { database: next, schema: rule.schema, table: rule.table });
    if (!r.ok) return setMessage({ text: `${rule.schema}.${rule.table} can't be used in ${next}: ${r.error}`, tone: "err" });
    setLoaded({ ...loaded, database: next, info: r.data.info, suggested: r.data.suggested });
    setPreview(null);
    setInserted(false);
    setMessage({ text: `Target database is now ${next}.`, tone: "ok" });
  };

  const runPreview = async () => {
    setBusy("preview");
    setMessage(null);
    const r = await api<GenerateResult>("preview", request());
    setBusy("");
    if (!r.ok) return setMessage({ text: r.error, tone: "err" });
    setInserted(false);
    setPreview(r.data);
  };

  const runInsert = async () => {
    setConfirm(false);
    setBusy("insert");
    setMessage(null);
    const r = await api<GenerateResult>("generate", request());
    setBusy("");
    if (!r.ok) return setMessage({ text: `Nothing was inserted: ${r.error}`, tone: "err" });
    setInserted(true);
    setPreview(r.data);
    setMessage({ text: `Inserted into ${database} (${loaded.target?.server ?? "server"}): ${r.data.tables.map((t) => `${t.rows} into ${t.schema}.${t.table}`).join(", ")} in ${(r.data.ms / 1000).toFixed(1)} s.`, tone: "ok" });
  };

  const save = async () => {
    setBusy("save");
    const r = await api<{ file: string; name: string }>("save", { ...request(), ...(file ? { file } : {}) });
    setBusy("");
    if (!r.ok) return setMessage({ text: r.error, tone: "err" });
    setFile(r.data.file);
    setSavedSnapshot(snapshot);
    setMessage({ text: `Saved to ${r.data.file} in the Fast Tools folder.`, tone: "ok" });
    window.oneclientView.refreshExplorer();
  };

  const showJson = async () => {
    const r = await api<string>("toJson", request());
    if (!r.ok) return setMessage({ text: r.error, tone: "err" });
    setJsonText(r.data as unknown as string);
    setJsonError("");
    setTab("json");
  };

  const applyJson = async () => {
    const r = await api<FakerDoc>("fromJson", { text: jsonText });
    if (!r.ok) return setJsonError(r.error);
    const doc = r.data;
    if (!same(doc.rule, rule)) return setJsonError(`This editor is for ${rule.schema}.${rule.table} — the JSON targets ${doc.rule.schema}.${doc.rule.table}. Create a new faker for another table.`);
    setRule({ ...doc.rule, columns: [...doc.rule.columns, ...(loaded.suggested?.columns ?? []).filter((c) => !doc.rule.columns.some((x) => x.column === c.column))] });
    setName(doc.name);
    setCount(doc.count);
    setSeed(doc.seed !== undefined ? String(doc.seed) : "");
    setAnyDatabase(!doc.database);
    setJsonError("");
    setTab("design");
  };

  const viewRows = () => {
    const sql = `SELECT TOP (1000) * FROM [${rule.schema}].[${rule.table}]`;
    window.oneclientView.openView({ viewId: "mssql.query", title: `${rule.table} rows`, params: { windowId: `faker-${Date.now()}`, database, sql, autorun: "1", title: `${rule.table} rows` } });
  };

  const nestedTables = (r: TableRule): string[] => [
    ...r.columns.flatMap((c) => (c.kind === "fk-new" && c.parent ? [`${c.parent.schema}.${c.parent.table}`, ...nestedTables(c.parent)] : [])),
    ...(r.children ?? []).flatMap((c) => [`${c.schema}.${c.table}`, ...nestedTables(c)]),
  ];
  const others = [...new Set(nestedTables(rule))];

  return (
    <div className="fk-page">
      <div className="fk-target" title="Where Preview reads from and Generate & insert writes to">
        <span className="fk-target-label">Target</span>
        <span className="fk-target-part" title="Server (login)">
          🖥 {loaded.target?.server || "server"}
          {loaded.target?.login ? <span className="fk-dim"> as {loaded.target.login}</span> : null}
        </span>
        <span className="fk-dim">›</span>
        <span className="fk-target-part">
          🗄
          <select className="fk-sel fk-dbsel" value={database} onChange={(e) => void switchDatabase(e.target.value)} title="Run this faker against another database (the table must exist there)">
            {[...new Set([database, ...(loaded.databases ?? [])])].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </span>
        <span className="fk-dim">›</span>
        <span className="fk-target-part fk-target-table">
          {loaded.info.schema}.{loaded.info.table}
        </span>
      </div>
      <div className="fk-bar">
        <label>
          Name <input className="fk-in" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 180 }} />
        </label>
        <label>
          Rows <input className="fk-in" type="number" min={1} max={100000} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} style={{ width: 80 }} />
        </label>
        <label title="Same seed → same data (leave empty for random)">
          Seed <input className="fk-in" type="number" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="random" style={{ width: 80 }} />
        </label>
        <label title="Don't tie the faker to this database (e.g. dev / test copies of the same schema)">
          <input type="checkbox" checked={anyDatabase} onChange={(e) => setAnyDatabase(e.target.checked)} /> any database
        </label>
        <span className="fk-spacer" />
        <button className="btn" onClick={() => loaded.suggested && setRule(loaded.suggested)} title="Back to the automatic suggestions (removes nested rows)">
          Reset
        </button>
        <button className="btn" disabled={busy !== "" || !loaded.folder} onClick={() => void save()} title={loaded.folder ? `Save as a .faker.json file in ${loaded.folder}` : "Attach a Fast Tools folder first (FAST TOOLS section → right-click the connection)"}>
          {file ? (dirty ? "Save ●" : "Saved") : "Save faker"}
        </button>
        <button className="btn" disabled={busy !== ""} onClick={() => void runPreview()}>
          {busy === "preview" ? "Generating…" : "Preview"}
        </button>
        <button className="btn primary" disabled={busy !== ""} onClick={() => setConfirm(true)}>
          {busy === "insert" ? "Inserting…" : "Generate & insert"}
        </button>
      </div>

      <div className="fk-tabs">
        <button className={`fk-tab ${tab === "design" ? "on" : ""}`} onClick={() => setTab("design")}>
          Design
        </button>
        <button className={`fk-tab ${tab === "json" ? "on" : ""}`} onClick={() => void showJson()}>
          JSON
        </button>
        {file && <span className="fk-dim fk-file">{file}</span>}
      </div>

      {confirm && (
        <div className="fk-confirm">
          Insert {count} row{count === 1 ? "" : "s"} into <strong>{database}</strong>.{rule.schema}.{rule.table} on <strong>{loaded.target?.server}</strong>
          {others.length > 0 && ` (plus nested / parent rows in ${others.join(", ")})`}? Everything goes in one transaction.
          <span className="fk-confirm-actions">
            <button className="btn primary" onClick={() => void runInsert()}>
              Insert
            </button>
            <button className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      {message && (
        <div className={`fk-message ${message.tone}`}>
          {message.text}
          {inserted && message.tone === "ok" && (
            <button className="fk-link" onClick={viewRows}>
              View rows
            </button>
          )}
        </div>
      )}

      <div className="fk-body">
        {tab === "json" ? (
          <div className="fk-json">
            <div className="fk-dim">
              The faker as it is saved (<code>.faker.json</code>). Edit and apply, or copy it into another folder. Columns you leave out get the automatic suggestion.
            </div>
            <textarea className="fk-jsonarea" value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} />
            {jsonError && <div className="fk-err">{jsonError}</div>}
            <div className="fk-row">
              <button className="btn primary" onClick={() => void applyJson()}>
                Apply
              </button>
              <button className="btn" onClick={() => setTab("design")}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <TableEditor info={loaded.info} rule={rule} suggested={loaded.suggested} onChange={setRule} catalog={loaded.catalog} depth={0} store={store} />
        )}

        {preview && tab === "design" && <PreviewTables result={preview} inserted={inserted} />}
      </div>
    </div>
  );
}

/** The preview / insert result: every table the faker touched, nested ones indented, one grid at a time. */
function PreviewTables({ result, inserted }: { result: GenerateResult; inserted: boolean }) {
  const samples: TableSample[] = result.samples ?? [];
  const mainIndex = Math.max(0, samples.findIndex((x) => x.depth === 0));
  const [selected, setSelected] = useState(mainIndex);
  useEffect(() => setSelected(mainIndex), [result, mainIndex]);
  const current = samples[selected];
  if (!current) return null;
  return (
    <div className="fk-preview">
      <div className="fk-preview-title">{inserted ? "Inserted — first rows of each table" : "Preview — nothing is written"}</div>
      <div className="fk-preview-tables">
        {samples.map((x, i) => (
          <button key={i} className={`fk-ptab ${i === selected ? "on" : ""}`} style={{ paddingLeft: 8 + x.depth * 14 }} onClick={() => setSelected(i)} title={x.relation || "the faker's table"}>
            {x.depth > 0 && <span className="fk-dim">↳ </span>}
            {x.schema}.{x.table}
            <span className="fk-count">{x.rows}</span>
            {x.relation && <span className="fk-rel">{x.relation}</span>}
          </button>
        ))}
      </div>
      <div className="fk-grid-wrap">
        <table className="fk-grid">
          <thead>
            <tr>
              {current.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {current.sample.map((row, i) => (
              <tr key={i}>
                {row.map((v, j) => (
                  <td key={j} className={v === null ? "fk-null" : typeof v === "string" && v.startsWith("‹new ") ? "fk-key" : ""}>
                    {v === null ? "NULL" : String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {current.rows > current.sample.length && <div className="fk-dim fk-more">first {current.sample.length} of {current.rows} rows</div>}
    </div>
  );
}
