import type { ReactNode } from "react";
import type { AuthDef, KV } from "../src/model.js";

/** Editable key / value / on-off table, with one spare row at the end to type into. */
export function KVTable<T extends KV>({
  rows,
  onChange,
  make,
  keyLabel = "Key",
  valueLabel = "Value",
  extra,
}: {
  rows: T[];
  onChange: (rows: T[]) => void;
  make: () => T;
  keyLabel?: string;
  valueLabel?: string;
  /** Extra cell per row (e.g. a type select), rendered before the delete button. */
  extra?: (row: T, update: (patch: Partial<T>) => void) => ReactNode;
}) {
  const set = (i: number, patch: Partial<T>) => onChange(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  const shown = [...rows, make()];
  return (
    <table className="kc-table kv-table">
      <thead>
        <tr>
          <th style={{ width: 28 }} />
          <th>{keyLabel}</th>
          <th>{valueLabel}</th>
          {extra && <th style={{ width: 110 }} />}
          <th style={{ width: 28 }} />
        </tr>
      </thead>
      <tbody>
        {shown.map((r, i) => {
          const ghost = i === rows.length;
          const update = (patch: Partial<T>) => (ghost ? onChange([...rows, { ...r, ...patch }]) : set(i, patch));
          return (
            <tr key={i} className={ghost ? "kv-ghost" : ""}>
              <td>{!ghost && <input type="checkbox" checked={r.enabled} onChange={(e) => update({ enabled: e.target.checked } as Partial<T>)} title="Enabled" />}</td>
              <td>
                <input className="kc-input kv-input" value={r.key} placeholder={ghost ? keyLabel : ""} onChange={(e) => update({ key: e.target.value } as Partial<T>)} spellCheck={false} />
              </td>
              <td>
                <input className="kc-input kv-input" value={r.value} placeholder={ghost ? valueLabel : ""} onChange={(e) => update({ value: e.target.value } as Partial<T>)} spellCheck={false} />
              </td>
              {extra && <td>{!ghost && extra(r, update)}</td>}
              <td>
                {!ghost && (
                  <button className="kc-link" title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                    ✕
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export const newKV = (): KV => ({ key: "", value: "", enabled: true });

const AUTH_TYPES: Array<[AuthDef["type"], string]> = [
  ["inherit", "Inherit from parent"],
  ["none", "No auth"],
  ["bearer", "Bearer token"],
  ["basic", "Basic auth"],
  ["apikey", "API key"],
];

export function emptyAuth(type: AuthDef["type"]): AuthDef {
  switch (type) {
    case "bearer":
      return { type, token: "" };
    case "basic":
      return { type, username: "", password: "" };
    case "apikey":
      return { type, key: "", value: "", in: "header" };
    default:
      return { type } as AuthDef;
  }
}

/** Auth type picker plus the fields of the chosen type. `inheritedLabel` explains what "inherit" resolves to. */
export function AuthEditor({ auth, onChange, allowInherit = true, inheritedLabel }: { auth: AuthDef; onChange: (a: AuthDef) => void; allowInherit?: boolean; inheritedLabel?: string }) {
  return (
    <div className="auth-editor">
      <div className="kc-field" style={{ maxWidth: 280 }}>
        <label>Type</label>
        <select className="kc-select" value={auth.type} onChange={(e) => onChange(emptyAuth(e.target.value as AuthDef["type"]))}>
          {AUTH_TYPES.filter(([t]) => allowInherit || t !== "inherit").map(([t, label]) => (
            <option key={t} value={t}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {auth.type === "inherit" && <div className="kc-muted">{inheritedLabel ?? "Uses the folder or collection setting."}</div>}
      {auth.type === "none" && <div className="kc-muted">This request is sent without credentials.</div>}
      {auth.type === "bearer" && (
        <div className="kc-field">
          <label>Token</label>
          <input className="kc-input" value={auth.token} onChange={(e) => onChange({ ...auth, token: e.target.value })} placeholder="{{token}}" spellCheck={false} />
          <span className="kc-muted">Sent as “Authorization: Bearer …”.</span>
        </div>
      )}
      {auth.type === "basic" && (
        <div className="kc-split" style={{ maxWidth: 560 }}>
          <div className="kc-field">
            <label>Username</label>
            <input className="kc-input" value={auth.username} onChange={(e) => onChange({ ...auth, username: e.target.value })} spellCheck={false} />
          </div>
          <div className="kc-field">
            <label>Password</label>
            <input className="kc-input" type="password" value={auth.password} onChange={(e) => onChange({ ...auth, password: e.target.value })} />
          </div>
        </div>
      )}
      {auth.type === "apikey" && (
        <div className="kc-split" style={{ maxWidth: 560 }}>
          <div className="kc-field">
            <label>Key</label>
            <input className="kc-input" value={auth.key} onChange={(e) => onChange({ ...auth, key: e.target.value })} placeholder="X-API-Key" spellCheck={false} />
          </div>
          <div className="kc-field">
            <label>Value</label>
            <input className="kc-input" value={auth.value} onChange={(e) => onChange({ ...auth, value: e.target.value })} spellCheck={false} />
          </div>
          <div className="kc-field">
            <label>Add to</label>
            <select className="kc-select" value={auth.in} onChange={(e) => onChange({ ...auth, in: e.target.value as "header" | "query" })}>
              <option value="header">Header</option>
              <option value="query">Query params</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

export const statusTone = (status: number): string => (status >= 500 ? "kc-error" : status >= 400 ? "warn" : status >= 300 ? "kc-muted" : "kc-ok");

export const formatBytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const methodClass = (m: string): string => `method m-${m.toLowerCase()}`;
