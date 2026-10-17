import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchHit, SearchProviderInfo } from "../../../shared/ipc-contract.js";
import { ThemeIcon, useResourceIcon } from "../theme.js";

interface Group {
  provider: SearchProviderInfo;
  state: "searching" | "done";
  hits: SearchHit[];
}

/**
 * The top-bar search ("Go to anything", Ctrl+P). Every plugin that declared a search provider is asked, in parallel,
 * as you type; each group appears when its plugin answers. Enter (or a click) opens the highlighted result — a file in
 * the editor, a SQL table as a "select top 1000" query window, and so on, as the plugin decides.
 */
export function QuickSearch({
  connectionCount,
  onOpen,
  onClose,
}: {
  connectionCount: number;
  onOpen: (hit: SearchHit) => void;
  onClose: () => void;
}) {
  const [providers, setProviders] = useState<SearchProviderInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [problems, setProblems] = useState<Array<{ connectionName: string; message: string }>>([]);
  const [selected, setSelected] = useState(0);
  const run = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.oneclient.searchProviders().then(setProviders);
  }, []);

  useEffect(() => {
    if (!providers) return;
    const text = query.trim();
    const id = ++run.current;
    setSelected(0);
    if (!text) {
      setGroups([]);
      setProblems([]);
      return;
    }
    setProblems([]);
    setGroups(providers.map((provider) => ({ provider, state: "searching", hits: [] })));
    const timer = setTimeout(() => {
      for (const provider of providers) {
        void window.oneclient
          .runSearch(provider.id, text)
          .then((outcome) => {
            if (run.current !== id) return; // a newer query is in flight
            setGroups((prev) => prev.map((g) => (g.provider.id === provider.id ? { ...g, state: "done", hits: outcome.hits } : g)));
            if (outcome.problems.length) setProblems((prev) => [...prev, ...outcome.problems]);
          })
          .catch((err: unknown) => {
            if (run.current !== id) return;
            setGroups((prev) => prev.map((g) => (g.provider.id === provider.id ? { ...g, state: "done" } : g)));
            setProblems((prev) => [...prev, { connectionName: provider.label, message: err instanceof Error ? err.message : String(err) }]);
          });
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [query, providers]);

  // With several groups answering, show the best few of each so one chatty provider can't push the others off screen.
  const cap = groups.filter((g) => g.hits.length > 0).length > 1 ? 8 : 50;
  const flat = useMemo(() => groups.flatMap((g) => g.hits.slice(0, cap)), [groups, cap]);
  const searching = groups.some((g) => g.state === "searching");

  useEffect(() => {
    listRef.current?.querySelector(".qs-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected, flat.length]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(flat.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter" && flat[selected]) {
      e.preventDefault();
      onOpen(flat[selected]!);
    }
  }

  let index = -1;
  return (
    <div className="palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette qs" onKeyDown={onKeyDown}>
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search files, tables, procedures… in all your connections" spellCheck={false} />
        <div className="palette-list qs-list" ref={listRef}>
          {providers && providers.length === 0 && <div className="qs-hint">No plugin offers search yet.</div>}
          {providers && providers.length > 0 && connectionCount === 0 && <div className="qs-hint">Add a connection first — search looks inside your connections (open folders, databases…).</div>}
          {!query.trim() && providers && providers.length > 0 && connectionCount > 0 && (
            <div className="qs-hint">
              Type to search across: {providers.map((p) => p.label).join(", ")}.<br />
              Use <kbd>Ctrl+Shift+P</kbd> for commands.
            </div>
          )}
          {groups.map((g) => {
            if (g.hits.length === 0 && g.state === "done") return null;
            return (
              <div key={g.provider.id}>
                <div className="qs-group">
                  {g.provider.label}
                  {g.state === "searching" ? <span className="qs-dim"> — searching…</span> : <span className="qs-dim"> — {g.hits.length}</span>}
                </div>
                {g.hits.slice(0, cap).map((hit) => {
                  index++;
                  const i = index;
                  return <Row key={`${hit.connectionId}:${i}:${hit.label}`} hit={hit} selected={i === selected} showConnection={connectionCount > 1} onHover={() => setSelected(i)} onOpen={() => onOpen(hit)} />;
                })}
                {g.hits.length > cap && <div className="qs-more">+{g.hits.length - cap} more — keep typing to narrow</div>}
              </div>
            );
          })}
          {query.trim() && !searching && flat.length === 0 && <div className="qs-hint">No results for “{query.trim()}”.</div>}
          {problems.length > 0 && (
            <div className="qs-problems" title={problems.map((p) => `${p.connectionName}: ${p.message}`).join("\n")}>
              Couldn’t search {problems.map((p) => p.connectionName).join(", ")} — {problems[0]!.message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ hit, selected, showConnection, onHover, onOpen }: { hit: SearchHit; selected: boolean; showConnection: boolean; onHover: () => void; onOpen: () => void }) {
  const themed = useResourceIcon(hit.resource);
  const icon = themed ?? hit.icon;
  const id = icon?.startsWith("$(") ? icon.slice(2, -1) : undefined;
  return (
    <div className={`qs-item ${selected ? "selected" : ""}`} onMouseMove={onHover} onClick={onOpen}>
      <span className="qs-icon">{id ? <ThemeIcon id={id} size={16} /> : null}</span>
      <span className="qs-label">{hit.label}</span>
      {hit.description && <span className="qs-desc">{hit.description}</span>}
      {showConnection && <span className="qs-conn">{hit.connectionName}</span>}
    </div>
  );
}
