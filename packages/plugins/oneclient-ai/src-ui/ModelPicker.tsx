import { useEffect, useMemo, useRef, useState } from "react";

export interface ModelRow {
  provider: string;
  providerLabel: string;
  id: string;
  label: string;
  priceIn?: number;
  priceOut?: number;
  ready: boolean;
  unavailable?: boolean;
}

const price = (n: number | undefined) => (n === undefined ? "—" : n < 1 ? n.toFixed(2) : n % 1 ? n.toFixed(2).replace(/0$/, "") : String(n));

/**
 * One table of every model: pick a row and the conversation uses it. Rows of providers without a key are dimmed
 * (add the key in the connection settings), so you can see what is available without adding a connection per model.
 */
export function ModelPicker({ value, rows, onOpen, onPick }: { value: string; rows: ModelRow[] | null; onOpen: (refresh: boolean) => void; onPick: (ref: string) => void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    input.current?.focus();
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const current = rows?.find((r) => `${r.provider}/${r.id}` === value);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (rows ?? []).filter((r) => !q || `${r.label} ${r.id} ${r.providerLabel}`.toLowerCase().includes(q));
  }, [rows, filter]);

  return (
    <div className="ai-picker" ref={box}>
      <button
        className="ai-picker-btn"
        title={`${value} — click to choose another model`}
        onClick={() => {
          if (!open && rows === null) onOpen(false);
          setOpen((o) => !o);
        }}
      >
        <span className="ai-picker-name">{current?.label ?? (value.split("/").slice(1).join("/") || "Pick a model")}</span>
        <span className="ai-caret">▾</span>
      </button>
      {open && (
        <div className="ai-picker-pop">
          <input ref={input} className="ai-picker-search" placeholder="Search models…" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
          <div className="ai-picker-scroll">
            {rows === null && <div className="ai-picker-note">Loading models…</div>}
            {rows !== null && shown.length === 0 && <div className="ai-picker-note">No model matches “{filter}”.</div>}
            {rows !== null && shown.length > 0 && (
              <table className="ai-picker-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Provider</th>
                    <th title="Approximate $ per 1M input tokens">In $</th>
                    <th title="Approximate $ per 1M output tokens">Out $</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const ref = `${r.provider}/${r.id}`;
                    return (
                      <tr
                        key={ref}
                        className={`${ref === value ? "sel" : ""}${r.ready ? "" : " off"}${r.unavailable ? " gone" : ""}`}
                        title={r.ready ? (r.unavailable ? "Your key does not list this model — it may be named differently" : ref) : "No API key for this provider — add it in the connection settings"}
                        onClick={() => {
                          if (!r.ready) return;
                          onPick(ref);
                          setOpen(false);
                        }}
                      >
                        <td>{r.label}</td>
                        <td>{r.providerLabel}</td>
                        <td className="num">{price(r.priceIn)}</td>
                        <td className="num">{price(r.priceOut)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <div className="ai-picker-foot">
            <span>Prices are approximate, $ per 1M tokens. Dimmed = no key yet.</span>
            <button className="ai-link" onClick={() => onOpen(true)}>Refresh</button>
          </div>
        </div>
      )}
    </div>
  );
}
