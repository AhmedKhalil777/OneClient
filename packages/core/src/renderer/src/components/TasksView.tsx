import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskInfo } from "../../../shared/ipc-contract.js";
import { ThemeIcon } from "../theme.js";

export const TASKS_SELECT_EVENT = "oneclient:tasks-select";

const MAX_OUTPUT = 400_000;

const elapsed = (t: TaskInfo) => {
  const ms = (t.endedAt ?? Date.now()) - t.startedAt;
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export const STATE_ICON: Record<TaskInfo["state"], string> = { running: "⟳", succeeded: "✓", failed: "✗", cancelled: "■" };

/** Basic ANSI SGR colours (what build tools print) → styled spans; anything else is dropped. */
const ANSI_COLORS = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5"];
const ANSI_BRIGHT = ["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
function renderAnsi(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let style: React.CSSProperties = {};
  let key = 0;
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([\d;]*)m|\x1b\[[\d;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(<span key={key++} style={style}>{text.slice(last, m.index)}</span>);
    last = m.index + m[0].length;
    if (m[1] === undefined) continue;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (const c of codes) {
      if (c === 0) style = {};
      else if (c === 1) style = { ...style, fontWeight: 600 };
      else if (c === 2) style = { ...style, opacity: 0.7 };
      else if (c === 22) style = { ...style, fontWeight: undefined, opacity: undefined };
      else if (c >= 30 && c <= 37) style = { ...style, color: ANSI_COLORS[c - 30] };
      else if (c >= 90 && c <= 97) style = { ...style, color: ANSI_BRIGHT[c - 90] };
      else if (c === 39) style = { ...style, color: undefined };
    }
  }
  if (last < text.length) out.push(<span key={key++} style={style}>{text.slice(last)}</span>);
  return out;
}

/**
 * The Tasks panel: every background task (Git fetch / pull / push, Task Runner builds, plugins' work) with its
 * state and live output; stop a running one, run a Task Runner task again, clear finished ones.
 */
export function TasksView({ visible, onRunTask }: { visible: boolean; onRunTask: () => void }) {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [, tick] = useState(0);
  const bodyRef = useRef<HTMLPreElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    void window.oneclient.listTasks().then(setTasks);
    const offChanged = window.oneclient.onTasksChanged(setTasks);
    const offOutput = window.oneclient.onTaskOutput(({ id, chunk }) => {
      if (id === selectedRef.current) setOutput((prev) => (prev + chunk).slice(-MAX_OUTPUT));
    });
    const onSelect = (e: Event) => setSelected((e as CustomEvent<string>).detail);
    window.addEventListener(TASKS_SELECT_EVENT, onSelect);
    return () => {
      offChanged();
      offOutput();
      window.removeEventListener(TASKS_SELECT_EVENT, onSelect);
    };
  }, []);

  // Follow the newest task unless the user picked one.
  const shown = useMemo(() => tasks.find((t) => t.id === selected) ?? tasks[0], [tasks, selected]);
  useEffect(() => {
    if (!shown) return setOutput("");
    if (selected !== shown.id) setSelected(shown.id);
    void window.oneclient.taskOutput(shown.id).then((text) => setOutput(text.slice(-MAX_OUTPUT)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.id]);

  // Keep the output scrolled to the end while it grows (unless the user scrolled up).
  useEffect(() => {
    const el = bodyRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [output]);

  // Running tasks show a live elapsed time.
  const running = tasks.some((t) => t.state === "running");
  useEffect(() => {
    if (!running || !visible) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running, visible]);

  const ansi = useMemo(() => renderAnsi(output), [output]);

  return (
    <div className="tasks-view">
      <div className="tasks-list">
        <div className="tasks-list-bar">
          <span>TASKS</span>
          <span className="output-spacer" />
          <button className="icon-button" title="Run Task…" onClick={onRunTask}>
            <ThemeIcon id="play" />
          </button>
          <button className="icon-button" title="Clear Finished" disabled={!tasks.some((t) => t.state !== "running")} onClick={() => void window.oneclient.clearFinishedTasks()}>
            <ThemeIcon id="clear-all" />
          </button>
        </div>
        {tasks.length === 0 && <div className="output-empty">No tasks yet. Run one with Terminal ▸ Run Task…; Git fetch / pull / push show up here too.</div>}
        {tasks.map((t) => (
          <div key={t.id} className={`task-row state-${t.state} ${shown?.id === t.id ? "selected" : ""}`} onClick={() => setSelected(t.id)} title={t.command ? `${t.command}\n${t.cwd ?? ""}` : t.title}>
            <span className={`task-state ${t.state === "running" ? "spin" : ""}`}>{STATE_ICON[t.state]}</span>
            <span className="task-title">{t.title}</span>
            <span className="task-meta">
              {t.source} · {elapsed(t)}
            </span>
            {t.state === "running" && t.progress !== undefined && (
              <span className="task-progress">
                <span style={{ width: `${Math.round(t.progress * 100)}%` }} />
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="tasks-output">
        {shown && (
          <div className="output-bar">
            <strong>{shown.title}</strong>
            <span className={`task-badge state-${shown.state}`}>{shown.state}</span>
            {shown.detail && <span className="task-detail">{shown.detail}</span>}
            <span className="output-spacer" />
            {shown.state === "running" && shown.cancellable && (
              <button className="output-btn" onClick={() => void window.oneclient.cancelTask(shown.id)}>
                ■ Stop
              </button>
            )}
            {shown.definitionId && shown.state !== "running" && (
              <button className="output-btn" onClick={() => void window.oneclient.runTask(shown.definitionId!)}>
                ▶ Run Again
              </button>
            )}
          </div>
        )}
        <pre className="tasks-body" ref={bodyRef}>
          {shown ? ansi : ""}
        </pre>
      </div>
    </div>
  );
}
