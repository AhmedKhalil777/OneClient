import { useEffect, useMemo, useRef, useState } from "react";
import type { OutputChannelState, OutputEntry, OutputLevel } from "@oneclient/backend/shared/output.js";
import type { PluginSummary } from "@oneclient/backend/shared/types.js";

export const OUTPUT_SELECT_KEY = "oneclient.outputChannel";
export const OUTPUT_SELECT_EVENT = "oneclient:output-select";
const LEVELS: OutputLevel[] = ["debug", "info", "warn", "error"];
const MAX_KEPT = 2000;

const timeText = (t: number) => `${new Date(t).toLocaleTimeString([], { hour12: false })}.${String(t % 1000).padStart(3, "0")}`;

/**
 * The shell's Output panel: one log stream per channel (plugins create them with `createOutputChannel`;
 * every plugin also gets a "Log" channel for its `logger`). The user picks the channel; entries stream in live.
 */
export function OutputView({ visible }: { visible: boolean }) {
  const [channels, setChannels] = useState<Map<string, OutputChannelState>>(new Map());
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [selected, setSelected] = useState(() => localStorage.getItem(OUTPUT_SELECT_KEY) ?? "");
  const [filter, setFilter] = useState("");
  const [minLevel, setMinLevel] = useState<OutputLevel>("debug");
  const [follow, setFollow] = useState(true);
  const [open, setOpen] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.oneclient.getOutput().then((all) => setChannels(new Map(all.map((c) => [c.id, c]))));
    void window.oneclient.listPlugins().then(setPlugins);
    const offPlugins = window.oneclient.onPluginsChanged(setPlugins);
    const offEntry = window.oneclient.onOutputEntry(({ channel, entry }) =>
      setChannels((prev) => {
        const next = new Map(prev);
        const cur = next.get(channel.id) ?? { ...channel, entries: [] };
        next.set(channel.id, { ...cur, entries: [...cur.entries, entry].slice(-MAX_KEPT) });
        return next;
      }),
    );
    const offClear = window.oneclient.onOutputCleared((id) =>
      setChannels((prev) => {
        const cur = prev.get(id);
        return cur ? new Map(prev).set(id, { ...cur, entries: [] }) : prev;
      }),
    );
    const onSelect = (e: Event) => setSelected(String((e as CustomEvent).detail ?? ""));
    window.addEventListener(OUTPUT_SELECT_EVENT, onSelect);
    return () => {
      offPlugins();
      offEntry();
      offClear();
      window.removeEventListener(OUTPUT_SELECT_EVENT, onSelect);
    };
  }, []);

  const nameOf = (pluginId: string) => (pluginId === "core" ? "oneClient" : (plugins.find((p) => p.id === pluginId)?.displayName ?? pluginId));
  const list = useMemo(
    () => [...channels.values()].sort((a, b) => nameOf(a.pluginId).localeCompare(nameOf(b.pluginId)) || a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channels, plugins],
  );
  const current = channels.get(selected) ?? list[0];

  useEffect(() => {
    if (current) localStorage.setItem(OUTPUT_SELECT_KEY, current.id);
  }, [current]);

  const shown: OutputEntry[] = useMemo(() => {
    if (!current) return [];
    const floor = LEVELS.indexOf(minLevel);
    const needle = filter.trim().toLowerCase();
    return current.entries.filter((e) => LEVELS.indexOf(e.level) >= floor && (!needle || `${e.message} ${e.detail ?? ""}`.toLowerCase().includes(needle)));
  }, [current, filter, minLevel]);

  useEffect(() => {
    if (follow && visible && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [shown, follow, visible]);

  return (
    <div className="output-view" data-ctx="output" data-ctx-channel={current?.id ?? ""}>
      <div className="output-bar">
        <select key={`${current?.id}:${list.length}:${plugins.length}`} className="output-select" value={current?.id ?? ""} onChange={(e) => setSelected(e.target.value)} disabled={list.length === 0} title="Choose an output channel">
          {list.length === 0 && <option value="">No output yet</option>}
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {nameOf(c.pluginId)} — {c.name}
            </option>
          ))}
        </select>
        <input className="output-filter" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select className="output-select" value={minLevel} onChange={(e) => setMinLevel(e.target.value as OutputLevel)} title="Minimum level">
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l === "debug" ? "All levels" : `${l} and up`}
            </option>
          ))}
        </select>
        <label className="output-check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <span className="output-spacer" />
        <button className="output-btn" disabled={!current} onClick={() => current && void window.oneclient.clearOutput(current.id)}>
          Clear
        </button>
      </div>
      <div className="output-body" ref={bodyRef} data-ctx="output-log" data-ctx-copy="">
        {!current ? (
          <div className="output-empty">Nothing has been logged yet. Plugins write here as they work — for example the Keycloak plugin logs every request it sends.</div>
        ) : shown.length === 0 ? (
          <div className="output-empty">{current.entries.length === 0 ? "This channel is empty." : "No entries match the filter."}</div>
        ) : (
          shown.map((e) => (
            <div key={e.id} className={`output-line level-${e.level}`} data-ctx="output-line" data-ctx-copy="">
              <div className="output-row" onClick={() => e.detail && setOpen(open === e.id ? null : e.id)} style={{ cursor: e.detail ? "pointer" : "default" }}>
                <span className="output-time">{timeText(e.time)}</span>
                <span className="output-level">{e.level}</span>
                <span className="output-msg">{e.message}</span>
                {e.detail && <span className="output-more">{open === e.id ? "▾" : "▸"}</span>}
              </div>
              {open === e.id && e.detail && <pre className="output-detail">{e.detail}</pre>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
