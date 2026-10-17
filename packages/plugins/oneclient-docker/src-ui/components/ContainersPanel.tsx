import { useState } from "react";
import {
  type ContainerRow,
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

export function ContainersPanel({ containers, onChanged }: { containers: ContainerRow[]; onChanged: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<ContainerRow | null>(null);

  async function run(action: (id: string) => Promise<{ ok: boolean; error?: string }>, container: ContainerRow) {
    setBusyId(container.id);
    setError(null);
    try {
      const result = await action(container.id);
      if (!result.ok) setError(result.error ?? "Action failed.");
      else onChanged();
    } finally {
      setBusyId(null);
    }
  }

  if (containers.length === 0) {
    return <div className="empty-state">No containers. Pull an image and run one with the Docker CLI to see it here.</div>;
  }

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
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
              </div>
              <span className={badgeClass(c.state)}>{c.state}</span>
              <div className="card-actions">
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
