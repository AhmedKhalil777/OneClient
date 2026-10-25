import { useEffect, useState } from "react";
import { ImagePicker } from "./ImagePicker.js";
import {
  type TestContainerRow,
  type TestContainerRequest,
  type WaitStrategy,
  cleanupTestContainers,
  listTestContainers,
  runTestContainer,
} from "../api.js";

type Status = { kind: "running" } | { kind: "done"; message: string } | { kind: "error"; message: string };

/**
 * Test containers: a throwaway container from any image, for scenarios no template covers. Ports can be left random
 * (just `8080`) — the endpoint Docker picked is reported once it is ready. Progress shows in the Tasks panel.
 */
export function TestContainersPanel({ onChanged }: { onChanged: () => void }) {
  const [image, setImage] = useState("nginx:alpine");
  const [name, setName] = useState("");
  const [ports, setPorts] = useState("80");
  const [env, setEnv] = useState("");
  const [cmd, setCmd] = useState("");
  const [waitKind, setWaitKind] = useState<WaitStrategy["kind"]>("port");
  const [logMessage, setLogMessage] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(60);
  const [ttlMinutes, setTtlMinutes] = useState(30);
  const [autoRemove, setAutoRemove] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [rows, setRows] = useState<TestContainerRow[]>([]);

  async function refresh() {
    try {
      setRows(await listTestContainers());
    } catch {
      /* the Containers tab already surfaces connection errors */
    }
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, []);

  async function run() {
    setStatus({ kind: "running" });
    const wait = (waitKind === "log" ? { kind: "log", message: logMessage } : { kind: waitKind }) as WaitStrategy;
    const request: TestContainerRequest = {
      image,
      name,
      ports: ports.split(/[\s,]+/).filter(Boolean),
      env,
      cmd,
      wait,
      timeoutSeconds,
      ttlMinutes,
      autoRemove,
    };
    try {
      const r = await runTestContainer(request);
      setStatus(r.ok ? { kind: "done", message: r.message ?? "Ready." } : { kind: "error", message: r.error ?? "Failed." });
      onChanged();
      void refresh();
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function cleanup() {
    const r = await cleanupTestContainers();
    setStatus(r.ok ? { kind: "done", message: r.message ?? "Done." } : { kind: "error", message: r.error ?? "Failed." });
    onChanged();
    void refresh();
  }

  const busy = status?.kind === "running";
  return (
    <>
      <p className="panel-intro">
        Run a throwaway container from any image — for a scenario no template covers. Containers are labelled <code>oneclient.testcontainer</code>, so one click cleans them all up. Progress shows in
        the <strong>Tasks</strong> panel.
      </p>
      <div className="template-card test-form">
        <div className="form-grid">
          <label>
            Image
            <ImagePicker value={image} disabled={busy} onChange={setImage} placeholder="Search images, e.g. postgres" />
          </label>
          <label>
            Container name <span className="dim">(optional)</span>
            <input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          </label>
          <label>
            Ports <span className="dim">(8080 = random host port · 9090:8080 = fixed · 53/udp)</span>
            <input value={ports} disabled={busy} onChange={(e) => setPorts(e.target.value)} spellCheck={false} />
          </label>
          <label>
            Environment <span className="dim">(KEY=VALUE per line)</span>
            <textarea value={env} disabled={busy} onChange={(e) => setEnv(e.target.value)} spellCheck={false} />
          </label>
          <label>
            Command <span className="dim">(optional — overrides the image default)</span>
            <input value={cmd} disabled={busy} onChange={(e) => setCmd(e.target.value)} spellCheck={false} />
          </label>
          <label>
            Wait until ready
            <select value={waitKind} disabled={busy} onChange={(e) => setWaitKind(e.target.value as WaitStrategy["kind"])}>
              <option value="none">Don't wait</option>
              <option value="port">A published port accepts connections</option>
              <option value="log">A log line appears</option>
              <option value="healthy">The image's health check passes</option>
            </select>
          </label>
          {waitKind === "log" && (
            <label>
              Log text
              <input value={logMessage} disabled={busy} onChange={(e) => setLogMessage(e.target.value)} spellCheck={false} placeholder="e.g. ready to accept connections" />
            </label>
          )}
          {waitKind !== "none" && (
            <label>
              Readiness timeout (seconds)
              <input type="number" min={1} value={timeoutSeconds} disabled={busy} onChange={(e) => setTimeoutSeconds(Number(e.target.value))} />
            </label>
          )}
          <label>
            Remove automatically after (minutes, 0 = keep)
            <input type="number" min={0} value={ttlMinutes} disabled={busy} onChange={(e) => setTtlMinutes(Number(e.target.value))} />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={autoRemove} disabled={busy} onChange={(e) => setAutoRemove(e.target.checked)} />
            Remove as soon as it exits
          </label>
        </div>
        <div className="template-actions">
          <button className="primary-btn" disabled={busy || !image.trim()} onClick={() => void run()}>
            {busy ? "Starting… (see Tasks)" : "Run test container"}
          </button>
          <button className="icon-btn icon-btn-danger" disabled={busy || rows.length === 0} onClick={() => void cleanup()}>
            Remove all ({rows.length})
          </button>
          {status?.kind === "done" && <span className="status-ok">✓ {status.message}</span>}
        </div>
        {status?.kind === "error" && <div className="error-banner pre">{status.message}</div>}
      </div>

      {rows.length > 0 && (
        <div className="card-grid">
          {rows.map((r) => (
            <div className="card" key={r.id}>
              <div className="card-main">
                <div className="card-title">{r.name}</div>
                <div className="card-sub mono">
                  {r.image} — {r.status}
                </div>
                <ul className="endpoint-list mono">
                  {Object.entries(r.endpoints).map(([port, where]) => (
                    <li key={port}>
                      {where} → {port}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
