import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog, Modal, api, fmtNum, open, qs, useToast } from "./kit.js";

interface Detail {
  groupId: string;
  state: string;
  protocol: string;
  members: Array<{ memberId: string; clientId: string; host: string; assignments: string }>;
  offsets: Array<{ topic: string; partition: number; committed: number | null; end: number; lag: number | null }>;
  totalLag: number;
}

const groupId = qs.get("groupId") ?? "";

/** One tab per consumer group: members, committed offsets and lag per partition, offset resets. */
export function GroupView() {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [auto, setAuto] = useState(false);
  const [dialog, setDialog] = useState<React.ReactNode>(null);
  const [toast, say] = useToast();

  const load = useCallback(async () => {
    const r = await api<Detail>("group", { groupId });
    if (!r.ok) return setError(r.error);
    setError("");
    setDetail(r.data);
  }, []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!auto) return;
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [auto, load]);

  const byTopic = useMemo(() => {
    const m = new Map<string, Detail["offsets"]>();
    for (const o of detail?.offsets ?? []) m.set(o.topic, [...(m.get(o.topic) ?? []), o]);
    return [...m.entries()];
  }, [detail]);

  const close = () => setDialog(null);
  const active = (detail?.members.length ?? 0) > 0;

  return (
    <div className="kc-page">
      <div className="kc-bar">
        <span className="kc-title">{groupId}</span>
        {detail && (
          <>
            <span className={`kc-badge${detail.state === "Stable" ? "" : " off"}`}>{detail.state}</span>
            <span className="kc-muted">
              {detail.members.length} member{detail.members.length === 1 ? "" : "s"}
              {detail.protocol ? ` · ${detail.protocol}` : ""}
            </span>
          </>
        )}
        <span className="kc-spacer" />
        <label className="kc-row" style={{ gap: 4 }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-refresh (5 s)
        </label>
        <button className="oce-btn" onClick={() => void load()}>
          Refresh
        </button>
        <button
          className="oce-btn"
          disabled={!detail}
          title={active ? "Stop the group's consumers first" : undefined}
          onClick={() =>
            setDialog(
              <ConfirmDialog
                title="Delete consumer group"
                text={`Delete "${groupId}" and its committed offsets? Its consumers will start again from their auto.offset.reset position.`}
                onClose={close}
                onConfirm={async () => {
                  const r = await api("deleteGroup", { groupId });
                  if (!r.ok) return say(r.error, true);
                  say("Consumer group deleted.");
                  window.oneclientView.refreshExplorer?.();
                  await load();
                }}
              />,
            )
          }
        >
          Delete group…
        </button>
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
      ) : (
        <div className="kc-body">
          {error && <div className="kc-error">{error}</div>}
          <div className="kf-cards">
            <div className="kf-card">
              <div className="l">Total lag</div>
              <div className={`v kf-lag${detail.totalLag > 0 ? " hot" : ""}`}>{fmtNum(detail.totalLag)}</div>
            </div>
            <div className="kf-card">
              <div className="l">Topics</div>
              <div className="v">{byTopic.length}</div>
            </div>
            <div className="kf-card">
              <div className="l">Partitions</div>
              <div className="v">{detail.offsets.length}</div>
            </div>
            <div className="kf-card">
              <div className="l">Members</div>
              <div className="v">{detail.members.length}</div>
            </div>
          </div>

          <h2 className="kc-h">Members</h2>
          {detail.members.length === 0 ? (
            <div className="kc-muted">No active consumers — offsets can be reset.</div>
          ) : (
            <table className="kc-table">
              <thead>
                <tr>
                  <th>Client id</th>
                  <th>Host</th>
                  <th>Assigned partitions</th>
                  <th>Member id</th>
                </tr>
              </thead>
              <tbody>
                {detail.members.map((m) => (
                  <tr key={m.memberId}>
                    <td>{m.clientId}</td>
                    <td>{m.host.replace(/^\//, "")}</td>
                    <td className="kf-mono">{m.assignments || <span className="kc-muted">—</span>}</td>
                    <td className="kf-mono kc-muted kf-trunc" style={{ maxWidth: 260 }}>
                      {m.memberId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {byTopic.length === 0 && (
            <>
              <h2 className="kc-h">Offsets</h2>
              <div className="kc-muted">The group hasn't committed any offsets.</div>
            </>
          )}
          {byTopic.map(([topic, rows]) => {
            const lag = rows.reduce((n, r) => n + (r.lag ?? 0), 0);
            return (
              <div key={topic}>
                <h2 className="kc-h kc-row">
                  <button className="kc-link" onClick={() => open("kafka.topic", topic, { topic }, "$(list-unordered)")}>
                    {topic}
                  </button>
                  <span className={`kf-lag${lag > 0 ? " hot" : ""}`} style={{ fontWeight: 400 }}>
                    lag {fmtNum(lag)}
                  </span>
                  <span className="kc-spacer" />
                  <button
                    className="oce-btn"
                    disabled={active}
                    title={active ? "Stop the group's consumers before resetting offsets" : "Move the group's position in this topic"}
                    onClick={() => setDialog(<ResetDialog topic={topic} onClose={close} onDone={async (msg) => (say(msg), await load())} />)}
                  >
                    Reset offsets…
                  </button>
                </h2>
                <table className="kc-table">
                  <thead>
                    <tr>
                      <th className="kf-num">Partition</th>
                      <th className="kf-num">Committed offset</th>
                      <th className="kf-num">End offset</th>
                      <th className="kf-num">Lag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.partition}>
                        <td className="kf-num">{r.partition}</td>
                        <td className="kf-num" title={r.committed === null ? "No offset committed: a consumer starts here according to its auto.offset.reset setting" : undefined}>
                          {r.committed === null ? <span className="kc-muted">not committed</span> : fmtNum(r.committed)}
                        </td>
                        <td className="kf-num">{fmtNum(r.end)}</td>
                        <td className={`kf-num kf-lag${(r.lag ?? 0) > 0 ? " hot" : ""}`}>{r.lag === null ? "—" : fmtNum(r.lag)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
      {dialog}
      {toast}
    </div>
  );
}

function ResetDialog({ topic, onClose, onDone }: { topic: string; onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const [to, setTo] = useState<"earliest" | "latest" | "timestamp">("earliest");
  const [when, setWhen] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await api("resetOffsets", { groupId, topic, to, ...(to === "timestamp" ? { timestamp: new Date(when).getTime() } : {}) });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onClose();
    await onDone(`Offsets of ${topic} reset to ${to === "timestamp" ? new Date(when).toLocaleString() : to}.`);
  };
  return (
    <Modal title={`Reset offsets — ${topic}`} onClose={onClose}>
      {(
        [
          ["earliest", "Earliest — re-read everything still retained"],
          ["latest", "Latest — skip everything, read only new messages"],
          ["timestamp", "From a date and time"],
        ] as const
      ).map(([v, label]) => (
        <label key={v} className="kc-row" style={{ gap: 6 }}>
          <input type="radio" name="to" checked={to === v} onChange={() => setTo(v)} /> {label}
        </label>
      ))}
      {to === "timestamp" && <input className="kc-input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}
      {error && <div className="kc-error">{error}</div>}
      <div className="kc-row" style={{ justifyContent: "flex-end" }}>
        <button className="oce-btn" onClick={onClose}>
          Cancel
        </button>
        <button className="oce-btn oce-btn-primary" disabled={busy || (to === "timestamp" && !when)} onClick={() => void submit()}>
          Reset
        </button>
      </div>
    </Modal>
  );
}
