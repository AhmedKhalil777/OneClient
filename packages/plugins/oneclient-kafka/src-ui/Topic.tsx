import { useCallback, useEffect, useMemo, useState } from "react";
import { FeatureEditor } from "@oneclient/editor-kit/editor";
import { ConfirmDialog, FormDialog, api, copy, fmtNum, fmtTime, qs, useToast } from "./kit.js";

interface Partition {
  partition: number;
  leader: number;
  replicas: number[];
  isr: number[];
  low: number;
  high: number;
  messages: number;
}
interface Config {
  name: string;
  value: string | null;
  isDefault: boolean;
  readOnly: boolean;
  sensitive: boolean;
}
interface Detail {
  name: string;
  partitions: Partition[];
  messages: number;
  configs: Config[];
}
interface Decoded {
  text: string;
  encoding: "text" | "json" | "base64" | "null";
  size: number;
}
interface Message {
  partition: number;
  offset: string;
  timestamp: number;
  key: Decoded;
  value: Decoded;
  headers: Record<string, string>;
}
interface Browse {
  messages: Message[];
  ranges: Array<{ partition: number; start: number; end: number }>;
  ms: number;
  timedOut: boolean;
}
interface Draft {
  key: string;
  value: string;
  partition: string;
  headers: Array<{ k: string; v: string }>;
  count: string;
}

const topic = qs.get("topic") ?? "";
const TABS = ["messages", "produce", "partitions", "configs"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { messages: "Messages", produce: "Produce", partitions: "Partitions", configs: "Configuration" };

const pretty = (d: Decoded) => {
  if (d.encoding !== "json") return d.text;
  try {
    return JSON.stringify(JSON.parse(d.text), null, 2);
  } catch {
    return d.text;
  }
};
const preview = (d: Decoded) => (d.encoding === "null" ? "null" : d.encoding === "base64" ? `binary, ${d.size} B` : d.text.replace(/\s+/g, " ").slice(0, 200));
const emptyDraft = (): Draft => ({ key: "", value: "{\n  \n}", partition: "", headers: [{ k: "", v: "" }], count: "1" });
/** "2026-10-18T09:30" in local time, for <input type="datetime-local">. */
const localInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};

/** One tab per topic: browse messages, produce, partitions and configuration. */
export function TopicView() {
  const [tab, setTab] = useState<Tab>(TABS.includes(qs.get("tab") as Tab) ? (qs.get("tab") as Tab) : "messages");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<React.ReactNode>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [toast, say] = useToast();

  const load = useCallback(async () => {
    const r = await api<Detail>("topic", { topic });
    if (!r.ok) return setError(r.error);
    setError("");
    setDetail(r.data);
  }, []);
  useEffect(() => void load(), [load]);

  const produceAgain = (m: Message) => {
    setDraft({
      key: m.key.encoding === "null" ? "" : m.key.text,
      value: m.value.encoding === "base64" ? "" : pretty(m.value),
      partition: "",
      headers: [...Object.entries(m.headers).map(([k, v]) => ({ k, v })), { k: "", v: "" }],
      count: "1",
    });
    setTab("produce");
  };

  return (
    <div className="kc-page">
      <div className="kc-bar">
        <span className="kc-title">{topic}</span>
        {detail && (
          <span className="kc-muted">
            {detail.partitions.length} partition{detail.partitions.length === 1 ? "" : "s"} · {fmtNum(detail.messages)} message{detail.messages === 1 ? "" : "s"} · replication {Math.max(0, ...detail.partitions.map((p) => p.replicas.length))}
          </span>
        )}
        <span className="kc-spacer" />
        <button className="oce-btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <div className="kc-tabs">
        {TABS.map((t) => (
          <button key={t} className={`kc-tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      {error && !detail ? (
        <div className="kc-message">
          <div className="kc-error">{error}</div>
          <button className="oce-btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : !detail ? (
        <div className="kc-message kc-muted">Loading…</div>
      ) : tab === "messages" ? (
        <Messages detail={detail} onProduceAgain={produceAgain} say={say} />
      ) : tab === "produce" ? (
        <Produce detail={detail} draft={draft} setDraft={setDraft} say={say} onSent={() => void load()} />
      ) : tab === "partitions" ? (
        <Partitions detail={detail} setDialog={setDialog} say={say} reload={load} />
      ) : (
        <Configs detail={detail} setDialog={setDialog} say={say} reload={load} />
      )}
      {dialog}
      {toast}
    </div>
  );
}

// ---- messages ----------------------------------------------------------------------------------------------------

function Messages({ detail, onProduceAgain, say }: { detail: Detail; onProduceAgain: (m: Message) => void; say: (t: string, e?: boolean) => void }) {
  const [from, setFrom] = useState<"latest" | "earliest" | "offset" | "timestamp">("latest");
  const [partition, setPartition] = useState("");
  const [offset, setOffset] = useState("0");
  const [when, setWhen] = useState(() => localInput(Date.now() - 3600_000));
  const [limit, setLimit] = useState("50");
  const [filter, setFilter] = useState("");
  const [result, setResult] = useState<Browse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Message | null>(null);

  const read = useCallback(async () => {
    setBusy(true);
    setError("");
    const r = await api<Browse>("browse", {
      topic,
      from,
      limit: Number(limit) || 50,
      ...(partition !== "" ? { partition: Number(partition) } : {}),
      ...(from === "offset" ? { offset: Number(offset) || 0 } : {}),
      ...(from === "timestamp" ? { timestamp: new Date(when).getTime() } : {}),
    });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setResult(r.data);
    setSel(null);
  }, [from, limit, partition, offset, when]);

  useEffect(() => {
    void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = result?.messages ?? [];
    if (!q) return list;
    return list.filter((m) => m.key.text.toLowerCase().includes(q) || m.value.text.toLowerCase().includes(q) || Object.entries(m.headers).some(([k, v]) => `${k}=${v}`.toLowerCase().includes(q)));
  }, [result, filter]);

  return (
    <>
      <div className="kc-bar">
        <select className="kc-select" value={from} onChange={(e) => setFrom(e.target.value as typeof from)} title="Where to start reading">
          <option value="latest">Newest messages</option>
          <option value="earliest">From the beginning</option>
          <option value="offset">From offset…</option>
          <option value="timestamp">From date/time…</option>
        </select>
        {from === "offset" && <input className="kc-input" style={{ width: 100 }} type="number" min={0} value={offset} onChange={(e) => setOffset(e.target.value)} placeholder="offset" />}
        {from === "timestamp" && <input className="kc-input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}
        <select className="kc-select" value={partition} onChange={(e) => setPartition(e.target.value)} title="Partition">
          <option value="">All partitions</option>
          {detail.partitions.map((p) => (
            <option key={p.partition} value={p.partition}>
              Partition {p.partition} ({fmtNum(p.messages)})
            </option>
          ))}
        </select>
        <label className="kc-muted">
          Limit{" "}
          <input className="kc-input" style={{ width: 70 }} type="number" min={1} max={2000} value={limit} onChange={(e) => setLimit(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void read()} />
        </label>
        <button className="oce-btn oce-btn-primary" disabled={busy} onClick={() => void read()}>
          {busy ? "Reading…" : "Read"}
        </button>
        <span className="kc-spacer" />
        <input className="kc-input" style={{ width: 200 }} placeholder="Filter key, value, headers" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {error && <div className="kc-error" style={{ padding: "6px 12px" }}>{error}</div>}
      {result && (
        <div className="kc-muted" style={{ padding: "4px 12px", fontSize: 12 }}>
          {shown.length === result.messages.length ? `${result.messages.length} message(s)` : `${shown.length} of ${result.messages.length} message(s) match`} · read in {result.ms} ms
          {result.timedOut ? " · stopped after 15 s (the topic may be busy or a partition unavailable)" : ""} — browsing never commits offsets.
        </div>
      )}
      <div className={`kf-msgs${sel ? "" : " solo"}`}>
        <div className="kf-list">
          {result && result.messages.length === 0 ? (
            <div className="kc-message kc-muted">No messages in that range.</div>
          ) : (
            <table className="kc-table">
              <thead>
                <tr>
                  <th className="kf-num">Partition</th>
                  <th className="kf-num">Offset</th>
                  <th>Time</th>
                  <th>Key</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((m) => (
                  <tr key={`${m.partition}:${m.offset}`} className={sel === m ? "kc-sel" : ""} style={{ cursor: "pointer" }} onClick={() => setSel(m)}>
                    <td className="kf-num">{m.partition}</td>
                    <td className="kf-num">{m.offset}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{fmtTime(m.timestamp)}</td>
                    <td className="kf-mono kf-trunc" style={{ maxWidth: 160 }}>
                      {m.key.encoding === "null" ? <span className="kc-muted">—</span> : preview(m.key)}
                    </td>
                    <td className="kf-mono kf-trunc">{m.value.encoding === "null" ? <span className="kc-muted">null (tombstone)</span> : preview(m.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {sel && <MessageDetail m={sel} onClose={() => setSel(null)} onProduceAgain={() => onProduceAgain(sel)} say={say} />}
      </div>
    </>
  );
}

function MessageDetail({ m, onClose, onProduceAgain, say }: { m: Message; onClose: () => void; onProduceAgain: () => void; say: (t: string, e?: boolean) => void }) {
  const text = pretty(m.value);
  const headers = Object.entries(m.headers);
  return (
    <div className="kf-detail">
      <div className="kf-meta">
        <div className="kc-row">
          <b>
            Partition {m.partition} · offset {m.offset}
          </b>
          <span className="kc-spacer" />
          <button className="oce-btn" onClick={async () => say((await copy(m.value.text)) ? "Value copied." : "Couldn't copy.", false)}>
            Copy value
          </button>
          <button className="oce-btn" onClick={onProduceAgain} title="Open Produce with this message's key, value and headers">
            Produce again…
          </button>
          <button className="oce-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className="kc-muted">
          {fmtTime(m.timestamp)} · value {m.value.size} B{m.value.encoding === "base64" ? " (binary, shown as base64)" : ""}
        </div>
        <div>
          <span className="kc-muted">Key: </span>
          <span className="kf-mono">{m.key.encoding === "null" ? "—" : m.key.text}</span>
        </div>
        {headers.length > 0 && (
          <table className="kc-table" style={{ marginTop: 4 }}>
            <tbody>
              {headers.map(([k, v]) => (
                <tr key={k}>
                  <td className="kc-muted" style={{ width: "30%" }}>
                    {k}
                  </td>
                  <td className="kf-mono">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="kf-ed">
        <FeatureEditor key={`${m.partition}:${m.offset}`} value={text} onChange={() => {}} readOnly fileName={m.value.encoding === "json" ? "message.json" : "message.txt"} />
      </div>
    </div>
  );
}

// ---- produce -----------------------------------------------------------------------------------------------------

function Produce({ detail, draft, setDraft, say, onSent }: { detail: Detail; draft: Draft; setDraft: (d: Draft) => void; say: (t: string, e?: boolean) => void; onSent: () => void }) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState("");
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setHeader = (i: number, patch: Partial<{ k: string; v: string }>) => {
    const headers = draft.headers.map((h, j) => (j === i ? { ...h, ...patch } : h)).filter((h, j, all) => h.k || h.v || j === all.length - 1);
    if (headers[headers.length - 1]?.k || headers[headers.length - 1]?.v) headers.push({ k: "", v: "" });
    set({ headers });
  };
  const looksJson = /^\s*[[{]/.test(draft.value);
  let jsonError = "";
  if (looksJson) {
    try {
      JSON.parse(draft.value);
    } catch (err) {
      jsonError = err instanceof Error ? err.message : String(err);
    }
  }

  const send = async () => {
    setBusy(true);
    const r = await api<{ results: Array<{ partition: number; offset: string }> }>("produce", {
      topic,
      key: draft.key,
      value: draft.value,
      headers: Object.fromEntries(draft.headers.filter((h) => h.k.trim()).map((h) => [h.k.trim(), h.v])),
      ...(draft.partition !== "" ? { partition: Number(draft.partition) } : {}),
      count: Number(draft.count) || 1,
    });
    setBusy(false);
    if (!r.ok) return say(r.error, true);
    const where = r.data.results.map((x) => `partition ${x.partition} @ offset ${x.offset}`).join(", ");
    setLast(`Sent ${Number(draft.count) || 1} message(s) — ${where}`);
    say("Message sent.");
    onSent();
  };

  return (
    <div className="kf-produce">
      <div className="kf-side">
        <div className="kc-field">
          <label>Key (optional — same key, same partition)</label>
          <input className="kc-input kf-mono" value={draft.key} onChange={(e) => set({ key: e.target.value })} />
        </div>
        <div className="kc-field">
          <label>Partition</label>
          <select className="kc-select" value={draft.partition} onChange={(e) => set({ partition: e.target.value })}>
            <option value="">Automatic (by key)</option>
            {detail.partitions.map((p) => (
              <option key={p.partition} value={p.partition}>
                Partition {p.partition}
              </option>
            ))}
          </select>
        </div>
        <div className="kc-field">
          <label>Headers</label>
          <table className="kv-table" style={{ width: "100%" }}>
            <tbody>
              {draft.headers.map((h, i) => (
                <tr key={i}>
                  <td>
                    <input className="kc-input kf-mono" style={{ width: "100%" }} placeholder="name" value={h.k} onChange={(e) => setHeader(i, { k: e.target.value })} />
                  </td>
                  <td>
                    <input className="kc-input kf-mono" style={{ width: "100%" }} placeholder="value" value={h.v} onChange={(e) => setHeader(i, { v: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="kc-field">
          <label>Copies to send</label>
          <input className="kc-input" type="number" min={1} max={10000} value={draft.count} onChange={(e) => set({ count: e.target.value })} />
        </div>
        <div className="kc-row">
          <button className="oce-btn oce-btn-primary" disabled={busy} onClick={() => void send()}>
            {busy ? "Sending…" : "Send"}
          </button>
          <button className="oce-btn" onClick={() => setDraft(emptyDraft())}>
            Clear
          </button>
        </div>
        {jsonError && <div className="warn">Value isn't valid JSON: {jsonError} (it will be sent as text).</div>}
        {last && <div className="kc-ok">{last}</div>}
      </div>
      <div className="kf-ed">
        <FeatureEditor value={draft.value} onChange={(value) => set({ value })} fileName={looksJson ? "message.json" : "message.txt"} onSave={() => void send()} toolbarStart={<span className="kc-muted">Value (Ctrl+S sends)</span>} />
      </div>
    </div>
  );
}

// ---- partitions --------------------------------------------------------------------------------------------------

interface ManageProps {
  detail: Detail;
  setDialog: (d: React.ReactNode) => void;
  say: (t: string, e?: boolean) => void;
  reload: () => Promise<void>;
}

function Partitions({ detail, setDialog, say, reload }: ManageProps) {
  const close = () => setDialog(null);
  return (
    <div className="kc-body">
      <div className="kc-row" style={{ marginBottom: 10 }}>
        <button
          className="oce-btn"
          onClick={() =>
            setDialog(
              <FormDialog
                title="Increase partitions"
                fields={[{ key: "count", label: `New total (now ${detail.partitions.length}; partitions can't be removed)`, required: true, value: String(detail.partitions.length + 1) }]}
                submitLabel="Increase"
                onClose={close}
                onSubmit={async (v) => {
                  const r = await api("addPartitions", { topic, count: Number(v.count) });
                  if (!r.ok) return r.error;
                  say("Partitions added.");
                  await reload();
                }}
              />,
            )
          }
        >
          Increase partitions…
        </button>
        <button
          className="oce-btn"
          onClick={() =>
            setDialog(
              <ConfirmDialog
                title="Empty topic"
                text={`Delete all ${fmtNum(detail.messages)} message(s) in "${topic}"? This can't be undone.`}
                confirmLabel="Empty topic"
                onClose={close}
                onConfirm={async () => {
                  const r = await api<{ removed: number }>("emptyTopic", { topic });
                  say(r.ok ? `Removed ${fmtNum(r.data.removed)} message(s).` : r.error, !r.ok);
                  await reload();
                }}
              />,
            )
          }
        >
          Empty topic…
        </button>
        <button
          className="oce-btn"
          onClick={() =>
            setDialog(
              <ConfirmDialog
                title="Delete topic"
                text={`Delete topic "${topic}" and all its messages? This can't be undone.`}
                onClose={close}
                onConfirm={async () => {
                  const r = await api("deleteTopic", { topic });
                  if (!r.ok) return say(r.error, true);
                  say("Topic deleted.");
                  window.oneclientView.refreshExplorer?.();
                  await reload();
                }}
              />,
            )
          }
        >
          Delete topic…
        </button>
      </div>
      <table className="kc-table">
        <thead>
          <tr>
            <th className="kf-num">Partition</th>
            <th className="kf-num">Leader</th>
            <th>Replicas</th>
            <th>In-sync replicas</th>
            <th className="kf-num">First offset</th>
            <th className="kf-num">Next offset</th>
            <th className="kf-num">Messages</th>
          </tr>
        </thead>
        <tbody>
          {detail.partitions.map((p) => (
            <tr key={p.partition}>
              <td className="kf-num">{p.partition}</td>
              <td className="kf-num">{p.leader < 0 ? <span className="kc-error">none</span> : p.leader}</td>
              <td>{p.replicas.join(", ")}</td>
              <td className={p.isr.length < p.replicas.length ? "warn" : ""}>
                {p.isr.join(", ")}
                {p.isr.length < p.replicas.length ? " (under-replicated)" : ""}
              </td>
              <td className="kf-num">{fmtNum(p.low)}</td>
              <td className="kf-num">{fmtNum(p.high)}</td>
              <td className="kf-num">{fmtNum(p.messages)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- configs -----------------------------------------------------------------------------------------------------

function Configs({ detail, setDialog, say, reload }: ManageProps) {
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState("");
  const close = () => setDialog(null);
  const rows = detail.configs.filter((c) => (all || !c.isDefault) && c.name.includes(filter.trim().toLowerCase()));

  const edit = (c: Config | null) =>
    setDialog(
      <FormDialog
        title={c ? `Set ${c.name}` : "Add configuration override"}
        fields={[...(c ? [] : [{ key: "name", label: "Name (e.g. retention.ms, cleanup.policy)", required: true }]), { key: "value", label: "Value", required: true, value: c?.value ?? "" }]}
        submitLabel="Save"
        onClose={close}
        onSubmit={async (v) => {
          const r = await api("setConfig", { topic, name: c?.name ?? String(v.name).trim(), value: String(v.value) });
          if (!r.ok) return r.error;
          say("Configuration saved.");
          await reload();
        }}
      />,
    );

  return (
    <div className="kc-body">
      <div className="kc-row" style={{ marginBottom: 10 }}>
        <button className="oce-btn" onClick={() => edit(null)}>
          Add override…
        </button>
        <label className="kc-row" style={{ gap: 4 }}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show defaults
        </label>
        <span className="kc-spacer" />
        <input className="kc-input" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {detail.configs.length === 0 ? (
        <div className="kc-muted">Configuration isn't available (the user may not be allowed to describe configs).</div>
      ) : rows.length === 0 ? (
        <div className="kc-muted">{all ? "Nothing matches." : "No overrides — the topic uses the broker defaults. Tick “Show defaults” to see them."}</div>
      ) : (
        <table className="kc-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.name}>
                <td className="kf-mono">{c.name}</td>
                <td className="kf-mono">{c.sensitive ? "••••" : (c.value ?? <span className="kc-muted">—</span>)}</td>
                <td>{c.isDefault ? <span className="kc-badge off">default</span> : <span className="kc-badge">override</span>}</td>
                <td>
                  {!c.readOnly && (
                    <div className="kc-actions">
                      <button className="kc-link" onClick={() => edit(c)}>
                        Edit
                      </button>
                      {!c.isDefault && (
                        <button
                          className="kc-link"
                          onClick={async () => {
                            const r = await api("setConfig", { topic, name: c.name, value: null });
                            say(r.ok ? `${c.name} reset to the default.` : r.error, !r.ok);
                            await reload();
                          }}
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
