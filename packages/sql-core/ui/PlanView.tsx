import { useCallback, useEffect, useMemo, useState } from "react";
import type { PlanMode, PlanNode, PlanResult } from "../src/plan/types.js";
import { invoke } from "./api.js";
import type { SqlDialectUi } from "./dialect.js";

/**
 * Execution plan viewer: the operator tree with each operator's share of the work, row estimates against what happened
 * (actual plans), warnings and the database's own index suggestions. "Actual" runs the statement inside a transaction
 * that is rolled back.
 */

const params = new URLSearchParams(globalThis.location?.search ?? "");
const sql = params.get("sql") ?? "";
const database = params.get("database") ?? undefined;
const initialMode: PlanMode = params.get("mode") === "actual" ? "actual" : "estimated";

type Answer<T> = { ok: true; data: T } | { ok: false; error: string };
interface Row {
  node: PlanNode;
  depth: number;
  hasChildren: boolean;
}

const n = (v: number | undefined) => (v === undefined ? "" : Math.round(v).toLocaleString());
const pct = (v: number) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v > 0 ? "<1" : "0");

function flatten(node: PlanNode, depth: number, collapsed: Set<number>, out: Row[] = []): Row[] {
  out.push({ node, depth, hasChildren: node.children.length > 0 });
  if (!collapsed.has(node.id)) for (const c of node.children) flatten(c, depth + 1, collapsed, out);
  return out;
}

export function PlanView({ dialect }: { dialect: SqlDialectUi }) {
  const [mode, setMode] = useState<PlanMode>(initialMode);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<"plan" | "raw">("plan");

  const load = useCallback(
    async (m: PlanMode) => {
      setBusy(true);
      setError(null);
      try {
        const r = await invoke<Answer<PlanResult>>(`${dialect.prefix}.explain`, { sql, database, mode: m });
        if (!r.ok) throw new Error(r.error);
        setPlan(r.data);
        setMode(m);
        setCollapsed(new Set());
        // Open on the most expensive operator, which is usually what the user came to find.
        let top: PlanNode = r.data.root;
        const walk = (x: PlanNode) => {
          if (x.percent > top.percent) top = x;
          x.children.forEach(walk);
        };
        walk(r.data.root);
        setSelected(top.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [dialect.prefix],
  );

  useEffect(() => {
    void load(initialMode);
  }, [load]);

  const rows = useMemo(() => (plan ? flatten(plan.root, 0, collapsed) : []), [plan, collapsed]);
  const current = useMemo(() => {
    if (!plan || selected === null) return null;
    const find = (x: PlanNode): PlanNode | null => (x.id === selected ? x : x.children.map(find).find(Boolean) ?? null);
    return find(plan.root);
  }, [plan, selected]);
  const actual = plan?.mode === "actual";

  return (
    <div className="te-page">
      <div className="toolbar">
        <strong className="te-title">Execution Plan</strong>
        <span className="toolbar-sep" />
        <button className={`btn ${mode === "estimated" ? "btn-on" : ""}`} disabled={busy} onClick={() => void load("estimated")} title="The plan the optimizer would use — nothing runs">
          Estimated
        </button>
        <button className={`btn ${mode === "actual" ? "btn-on" : ""}`} disabled={busy} onClick={() => void load("actual")} title="Runs the statement (in a transaction that is rolled back) and adds the real row counts and times">
          Actual
        </button>
        <span className="toolbar-sep" />
        <button className={`btn ${tab === "plan" ? "btn-on" : ""}`} onClick={() => setTab("plan")}>
          Plan
        </button>
        <button className={`btn ${tab === "raw" ? "btn-on" : ""}`} onClick={() => setTab("raw")} title="The plan exactly as the database printed it">
          {plan?.rawKind === "xml" ? "XML" : plan?.rawKind === "text" ? "Text" : "JSON"}
        </button>
        <span className="spacer" />
        {busy && <span className="te-range">{mode === "actual" ? "Running…" : "Analysing…"}</span>}
      </div>
      {error && <div className="te-error">{error}</div>}
      {plan && (
        <>
          <div className="pl-summary">
            {plan.summary.map(([k, v]) => (
              <span key={k} className="pl-fact">
                <span className="pl-k">{k}</span> {v}
              </span>
            ))}
            <span className="pl-sql" title={plan.statement}>
              {plan.statement.replace(/\s+/g, " ")}
            </span>
          </div>
          {plan.hints.map((h, i) => (
            <div key={i} className="te-banner pl-hint">
              {h}
              <button className="btn" onClick={() => void navigator.clipboard?.writeText(h.replace(/^Missing index[^:]*: /, ""))} title="Copy the statement">
                Copy
              </button>
            </div>
          ))}
          {tab === "raw" ? (
            <pre className="te-script pl-raw">{plan.raw}</pre>
          ) : (
            <>
              <div className="pl-grid">
                <div className="pl-row pl-head">
                  <div className="pl-op">Operator</div>
                  <div className="pl-num">Est. rows</div>
                  {actual && <div className="pl-num">Actual rows</div>}
                  {actual && <div className="pl-num">Time (ms)</div>}
                  <div className="pl-share">Share of work</div>
                </div>
                {rows.map(({ node, depth, hasChildren }) => (
                  <div key={node.id} className={`pl-row ${selected === node.id ? "selected" : ""}`} onClick={() => setSelected(node.id)}>
                    <div className="pl-op" style={{ paddingLeft: 8 + depth * 18 }}>
                      <span
                        className={`pl-twisty ${hasChildren ? "" : "none"}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCollapsed((c) => {
                            const next = new Set(c);
                            if (!next.delete(node.id)) next.add(node.id);
                            return next;
                          });
                        }}
                      >
                        {hasChildren ? (collapsed.has(node.id) ? "▸" : "▾") : ""}
                      </span>
                      <span className="pl-name">{node.op}</span>
                      {node.object && <span className="pl-object"> {node.object}</span>}
                      {node.warnings.length > 0 && (
                        <span className="pl-warn" title={node.warnings.join("\n")}>
                          ⚠ {node.warnings.length}
                        </span>
                      )}
                    </div>
                    <div className="pl-num">{n(node.estRows)}</div>
                    {actual && <div className={`pl-num ${node.warnings.some((w) => w.startsWith("Row estimate")) ? "bad" : ""}`}>{n(node.actRows)}</div>}
                    {actual && <div className="pl-num">{node.time !== undefined ? node.time.toLocaleString(undefined, { maximumFractionDigits: 1 }) : ""}</div>}
                    <div className="pl-share">
                      <div className="pl-bar">
                        <div className={`pl-barfill ${node.percent >= 40 ? "hot" : node.percent >= 15 ? "warm" : ""}`} style={{ width: `${Math.min(100, node.percent)}%` }} />
                      </div>
                      <span className="pl-pct">{pct(node.percent)}%</span>
                    </div>
                  </div>
                ))}
              </div>
              {current && (
                <div className="pl-details">
                  <div className="pl-dtitle">
                    {current.op}
                    {current.object ? ` — ${current.object}` : ""}
                  </div>
                  {current.warnings.map((w, i) => (
                    <div key={i} className="pl-dwarn">
                      ⚠ {w}
                    </div>
                  ))}
                  <table className="pl-props">
                    <tbody>
                      {current.props.map(([k, v], i) => (
                        <tr key={i}>
                          <th>{k}</th>
                          <td>{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
