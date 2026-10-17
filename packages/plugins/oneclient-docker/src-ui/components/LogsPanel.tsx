import { useEffect, useRef, useState } from "react";
import { tailLogs } from "../api.js";

export function LogsPanel({ containerId, name, onClose }: { containerId: string; name: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    const stop = tailLogs(containerId, (event) => {
      if (event.type === "logLine") {
        setLines((prev) => [...prev, ...event.text.split("\n").filter((l) => l.length > 0)]);
      } else if (event.type === "logError") {
        setLines((prev) => [...prev, `[error] ${event.error}`]);
      } else if (event.type === "logEnd") {
        setLines((prev) => [...prev, "[stream ended]"]);
      }
    });
    return stop;
  }, [containerId]);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [lines]);

  return (
    <div className="logs-overlay" onMouseDown={onClose}>
      <div className="logs-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="logs-header">
          <strong>Logs: {name}</strong>
          <button className="icon-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="logs-body" ref={bodyRef}>
          {lines.length === 0 ? (
            <span style={{ color: "var(--text-dim)" }}>Waiting for log output…</span>
          ) : (
            lines.map((line, i) => (
              <div key={i} className={line.startsWith("[error]") ? "log-error" : undefined}>
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
