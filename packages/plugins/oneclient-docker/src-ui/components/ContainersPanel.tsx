import { useState } from "react";
import { Icon } from "@oneclient/editor-kit/react";
import {
  type ContainerRow,
  connectContainer,
  removeContainer,
  restartContainer,
  startContainer,
  stopContainer,
} from "../api.js";
import { LogsPanel } from "./LogsPanel.js";

function badgeClass(state: string): string {
  if (state === "running") return "badge badge-running";
  if (state === "exited" || state === "dead") return "badge badge-exited";
  return "badge badge-other";
}

export function ContainersPanel({ containers, onChanged, onShowTemplates }: { containers: ContainerRow[]; onChanged: () => void; onShowTemplates: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<ContainerRow | null>(null);

  async function run(action: (id: string) => Promise<{ ok: boolean; error?: string }>, container: ContainerRow) {
    setBusyId(container.id);
    setError(null);
    try {
      const result = await action(container.id);
      if (!result.ok) setError(result.error ?? "Action failed.");
      else {
        setNotice((result as { message?: string }).message ?? null);
        onChanged();
      }
    } finally {
      setBusyId(null);
    }
  }

  if (containers.length === 0) {
    return (
      <div className="empty-state">
        No containers yet. <button className="link-btn" onClick={onShowTemplates}>Run one from a template</button> — PostgreSQL, Redis, Kafka and more, with a ready connection.
      </div>
    );
  }

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}
      <div className="card-grid">
        {containers.map((c) => {
          const busy = busyId === c.id;
          const running = c.state === "running";
          return (
            <div className="card" key={c.id}>
              <div className="card-main">
                <div className="card-title">{c.name}</div>
                <div className="card-sub">
                  {c.image} — {c.status}
                  {c.ports.length > 0 ? ` — ${c.ports.join(", ")}` : ""}
                </div>
                {c.plugin && (
                  <div className="plugin-line">
                    {c.plugin.icon.startsWith("$(") && <Icon id={c.plugin.icon.slice(2, -1)} size={14} />}
                    <span className="plugin-name">{c.plugin.product}</span>
                    {c.plugin.connections.length > 0 ? (
                      <span className="plugin-linked">→ {c.plugin.connections.map((x) => x.name).join(", ")}</span>
                    ) : (
                      <span className="dim">no connection yet</span>
                    )}
                  </div>
                )}
              </div>
              <span className={badgeClass(c.state)}>{c.state}</span>
              <div className="card-actions">
                {c.plugin && c.plugin.connections.length === 0 && running && (
                  <button className="icon-btn icon-btn-accent" disabled={busy} title={`Save a ${c.plugin.product} connection to this container`} onClick={() => void run(connectContainer, c)}>
                    Create connection
                  </button>
                )}
                {running ? (
                  <button className="icon-btn" disabled={busy} onClick={() => void run(stopContainer, c)}>
                    Stop
                  </button>
                ) : (
                  <button className="icon-btn" disabled={busy} onClick={() => void run(startContainer, c)}>
                    Start
                  </button>
                )}
                <button className="icon-btn" disabled={busy} onClick={() => void run(restartContainer, c)}>
                  Restart
                </button>
                <button className="icon-btn" disabled={!running} onClick={() => setLogsFor(c)}>
                  Logs
                </button>
                <button
                  className="icon-btn icon-btn-danger"
                  disabled={busy}
                  onClick={() => void run(removeContainer, c)}
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {logsFor && <LogsPanel containerId={logsFor.id} name={logsFor.name} onClose={() => setLogsFor(null)} />}
    </>
  );
}
