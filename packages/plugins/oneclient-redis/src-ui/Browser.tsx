import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog, api, open, qs, useToast } from "./kit.js";
import { TYPE_LABEL, formatTtl } from "./Key.js";

type Tab = "keys" | "cli" | "info" | "slowlog";
interface ScanKey {
  name: string;
  type: string;
  ttl?: number;
}
interface Overview {
  version: string;
  mode: string;
  os: string;
  uptimeDays: number;
  connectedClients: number;
  usedMemoryHuman: string;
  maxMemoryHuman: string;
  opsPerSec: number;
  hitRate: number | null;
  role: string;
  sections: Record<string, Record<string, string>>;
}

const TYPES = ["", "string", "hash", "list", "set", "zset", "stream", "ReJSON-RL"];

/** The connection's dashboard: key browser, CLI, server info and slow log — for one database at a time. */
export function Browser() {
  const [db, setDb] = useState(Number(qs.get("db") ?? 0));
  const [dbs, setDbs] = useState<Array<{ index: number; keys: number }>>([]);
  const [dbCount, setDbCount] = useState(16);
  const [tab, setTab] = useState<Tab>((qs.get("tab") as Tab) || "keys");
  const [toast, say] = useToast();

  useEffect(() => {
    void api<{ count: number; list: Array<{ index: number; keys: number }> }>("databases").then((r) => {
      if (!r.ok) return say(r.error, true);
      setDbs(r.data.list);
      setDbCount(r.data.count);
    });
  }, [say]);

  const keysIn = (i: number) => dbs.find((d) => d.index === i)?.keys ?? 0;

  return (
    <div className="kc-page">
      <div className="kc-bar">
        <span className="kc-title">Redis</span>
        <select className="kc-select" value={db} onChange={(e) => setDb(Number(e.target.value))} title="Database">
          {Array.from({ length: Math.max(dbCount, ...dbs.map((d) => d.index + 1)) }, (_, i) => (
            <option key={i} value={i}>
              db{i}
              {keysIn(i) ? ` (${keysIn(i).toLocaleString()} keys)` : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="kc-tabs">
        {(
          [
            ["keys", "Keys"],
            ["cli", "CLI"],
            ["info", "Server info"],
            ["slowlog", "Slow log"],
          ] as Array<[Tab, string]>
        ).map(([t, label]) => (
          <button key={t} className={`kc-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      <div className="kc-body rk-browser-body">
        {tab === "keys" && <Keys db={db} say={say} />}
        {tab === "cli" && <Cli db={db} />}
        {tab === "info" && <Info db={db} say={say} />}
        {tab === "slowlog" && <SlowLog db={db} say={say} />}
      </div>
      {toast}
    </div>
  );
}

function Keys({ db, say }: { db: number; say: (t: string, e?: boolean) => void }) {
  const [match, setMatch] = useState(qs.get("match") ?? "*");
  const [type, setType] = useState("");
  const [keys, setKeys] = useState<ScanKey[]>([]);
  const [cursor, setCursor] = useState("0");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<React.ReactNode>(null);

  const scan = useCallback(
    async (more: boolean) => {
      setBusy(true);
      const r = await api<{ keys: ScanKey[]; cursor: string }>("scan", { db, match: match || "*", type, limit: 200, ...(more ? { cursor } : {}) });
      setBusy(false);
      if (!r.ok) return say(r.error, true);
      setKeys((prev) => (more ? [...prev, ...r.data.keys.filter((k) => !prev.some((p) => p.name === k.name))] : r.data.keys));
      setCursor(r.data.cursor);
      if (!more) setSelected(new Set());
    },
    [db, match, type, cursor, say],
  );

  useEffect(() => {
    void scan(false);
    // re-scan when the database or type filter changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, type]);

  const openKey = (k: ScanKey) => open("redis.key", k.name, { db: String(db), key: k.name }, "$(key)");

  return (
    <div>
      <div className="kc-row" style={{ marginBottom: 8 }}>
        <input className="kc-input rk-pattern" value={match} onChange={(e) => setMatch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void scan(false)} placeholder="Pattern, e.g. user:* or *session*" spellCheck={false} />
        <select className="kc-select" value={type} onChange={(e) => setType(e.target.value)}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t ? TYPE_LABEL[t] ?? t : "All types"}
            </option>
          ))}
        </select>
        <button className="oce-btn oce-btn-primary" disabled={busy} onClick={() => void scan(false)}>
          {busy ? "Scanning…" : "Scan"}
        </button>
        <span className="kc-muted">
          {keys.length.toLocaleString()} key{keys.length === 1 ? "" : "s"}
          {cursor !== "0" ? " so far" : ""}
        </span>
        <span className="kc-spacer" />
        {selected.size > 0 && (
          <button
            className="oce-btn"
            onClick={() =>
              setDialog(
                <ConfirmDialog
                  title="Delete keys"
                  text={`Delete ${selected.size} selected key${selected.size === 1 ? "" : "s"}?`}
                  onClose={() => setDialog(null)}
                  onConfirm={async () => {
                    const r = await api<{ removed: number }>("delete", { db, keys: [...selected] });
                    if (!r.ok) return say(r.error, true);
                    say(`Deleted ${r.data.removed} key(s).`);
                    window.oneclientView.refreshExplorer();
                    await scan(false);
                  }}
                />,
              )
            }
          >
            Delete {selected.size} selected
          </button>
        )}
      </div>
      <table className="kc-table">
        <thead>
          <tr>
            <th style={{ width: 28 }}>
              <input type="checkbox" checked={keys.length > 0 && selected.size === keys.length} onChange={(e) => setSelected(e.target.checked ? new Set(keys.map((k) => k.name)) : new Set())} />
            </th>
            <th>Key</th>
            <th style={{ width: 110 }}>Type</th>
            <th style={{ width: 120 }}>TTL</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.name}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(k.name)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(k.name);
                    else next.delete(k.name);
                    setSelected(next);
                  }}
                />
              </td>
              <td>
                <button className="kc-link rk-mono" onClick={() => openKey(k)}>
                  {k.name}
                </button>
              </td>
              <td>
                <span className={`rk-type rk-${k.type.replace(/[^a-z]/gi, "")}`}>{TYPE_LABEL[k.type] ?? k.type}</span>
              </td>
              <td className="kc-muted">{k.ttl !== undefined ? formatTtl(k.ttl) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {keys.length === 0 && !busy && <div className="kc-message kc-muted">No keys match.</div>}
      {cursor !== "0" && (
        <div className="kc-row" style={{ marginTop: 8 }}>
          <button className="oce-btn" disabled={busy} onClick={() => void scan(true)}>
            Scan more
          </button>
          <span className="kc-muted">SCAN walks the keyspace in pages — keep going to see more matches.</span>
        </div>
      )}
      {dialog}
    </div>
  );
}

interface CliLine {
  command: string;
  output: string;
  error: boolean;
  ms: number;
}

function Cli({ db }: { db: number }) {
  const [lines, setLines] = useState<CliLine[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [pos, setPos] = useState(-1);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [lines]);
  useEffect(() => inputRef.current?.focus(), []);

  const run = async () => {
    const line = input.trim();
    if (!line || busy) return;
    if (/^(clear|cls)$/i.test(line)) {
      setLines([]);
      setInput("");
      return;
    }
    setBusy(true);
    setHistory((h) => [line, ...h.filter((x) => x !== line)].slice(0, 100));
    setPos(-1);
    setInput("");
    const r = await api<CliLine>("cli", { db, line });
    setBusy(false);
    setLines((prev) => [...prev, r.ok ? (r.data as unknown as CliLine) : { command: line, output: `(error) ${r.error}`, error: true, ms: 0 }]);
  };

  return (
    <div className="rk-cli" onClick={() => inputRef.current?.focus()}>
      <div className="rk-cli-out">
        {lines.length === 0 && <div className="kc-muted">Type a Redis command (e.g. <code>INFO memory</code>, <code>HGETALL user:1</code>). ↑/↓ for history, “clear” to clear. This console runs on db{db}.</div>}
        {lines.map((l, i) => (
          <div key={i} className="rk-cli-entry">
            <div className="rk-cli-cmd">
              db{db}&gt; {l.command} <span className="kc-muted">{l.ms ? `${l.ms} ms` : ""}</span>
            </div>
            <pre className={`rk-cli-res ${l.error ? "kc-error" : ""}`}>{l.output}</pre>
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="rk-cli-in">
        <span className="rk-prompt">db{db}&gt;</span>
        <input
          ref={inputRef}
          className="rk-cli-input"
          value={input}
          disabled={busy}
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
            else if (e.key === "ArrowUp" && history.length) {
              e.preventDefault();
              const p = Math.min(history.length - 1, pos + 1);
              setPos(p);
              setInput(history[p]!);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const p = pos - 1;
              setPos(Math.max(-1, p));
              setInput(p >= 0 ? history[p]! : "");
            }
          }}
          placeholder={busy ? "running…" : "command"}
        />
      </div>
    </div>
  );
}

function Info({ db, say }: { db: number; say: (t: string, e?: boolean) => void }) {
  const [info, setInfo] = useState<Overview | null>(null);
  const load = useCallback(async () => {
    const r = await api<Overview>("info", { db });
    if (!r.ok) return say(r.error, true);
    setInfo(r.data as unknown as Overview);
  }, [db, say]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!info) return <div className="kc-muted">Loading…</div>;
  const cards: Array<[string, string]> = [
    ["Version", `${info.version} (${info.mode})`],
    ["Role", info.role],
    ["Uptime", `${info.uptimeDays} day${info.uptimeDays === 1 ? "" : "s"}`],
    ["Clients", String(info.connectedClients)],
    ["Memory", `${info.usedMemoryHuman}${info.maxMemoryHuman && info.maxMemoryHuman !== "0B" ? ` / ${info.maxMemoryHuman}` : ""}`],
    ["Ops / sec", String(info.opsPerSec)],
    ["Hit rate", info.hitRate === null ? "—" : `${(info.hitRate * 100).toFixed(1)}%`],
    ["OS", info.os],
  ];
  return (
    <div>
      <div className="kc-row" style={{ marginBottom: 10 }}>
        <button className="oce-btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <div className="rk-cards">
        {cards.map(([k, v]) => (
          <div className="rk-card" key={k}>
            <div className="kc-muted">{k}</div>
            <div className="rk-card-v">{v}</div>
          </div>
        ))}
      </div>
      {Object.entries(info.sections).map(([name, values]) => (
        <details key={name} className="rk-section" open={name === "keyspace"}>
          <summary>{name}</summary>
          <table className="kc-table">
            <tbody>
              {Object.entries(values).map(([k, v]) => (
                <tr key={k}>
                  <td className="rk-mono kc-muted" style={{ width: "40%" }}>
                    {k}
                  </td>
                  <td className="rk-mono">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </div>
  );
}

function SlowLog({ db, say }: { db: number; say: (t: string, e?: boolean) => void }) {
  const [rows, setRows] = useState<Array<{ id: number; time: number; micros: number; command: string; client: string }> | null>(null);
  const load = useCallback(async () => {
    const r = await api<typeof rows>("slowlog", { db });
    if (!r.ok) return say(r.error, true);
    setRows(r.data as unknown as NonNullable<typeof rows>);
  }, [db, say]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!rows) return <div className="kc-muted">Loading…</div>;
  return (
    <div>
      <div className="kc-row" style={{ marginBottom: 10 }}>
        <button className="oce-btn" onClick={() => void load()}>
          Refresh
        </button>
        <span className="kc-muted">Commands slower than the server's slowlog-log-slower-than threshold.</span>
      </div>
      {rows.length === 0 ? (
        <div className="kc-muted">The slow log is empty.</div>
      ) : (
        <table className="kc-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Duration</th>
              <th>Command</th>
              <th>Client</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="kc-muted">{new Date(r.time).toLocaleString()}</td>
                <td>{r.micros >= 1000 ? `${(r.micros / 1000).toFixed(1)} ms` : `${r.micros} µs`}</td>
                <td className="rk-mono rk-value" title={r.command}>
                  {r.command}
                </td>
                <td className="kc-muted">{r.client}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
