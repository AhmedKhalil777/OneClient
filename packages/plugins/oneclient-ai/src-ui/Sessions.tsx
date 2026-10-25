import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.js";

export interface SessionItem {
  id: string;
  title: string;
  updatedAt: string;
  running?: boolean;
}

const DAY = 86_400_000;

function group(updatedAt: string, now: number): string {
  const d = new Date(updatedAt);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const age = start.getTime() - d.getTime();
  if (d.getTime() >= start.getTime()) return "Today";
  if (age <= DAY) return "Yesterday";
  if (age <= 7 * DAY) return "This week";
  if (age <= 30 * DAY) return "This month";
  return "Older";
}

function ago(updatedAt: string, now: number): string {
  const s = Math.max(0, (now - new Date(updatedAt).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The list of conversations: search, grouped by day, open one, rename or delete (two clicks) on hover. */
export function Sessions({ items, current, onOpen, onNew, onDelete, onRename, onClose, onRefresh }: {
  items: SessionItem[] | null;
  current: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const now = Date.now();

  useEffect(() => {
    search.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const out = new Map<string, SessionItem[]>();
    for (const s of items ?? []) {
      if (q && !s.title.toLowerCase().includes(q)) continue;
      const g = group(s.updatedAt, now);
      out.set(g, [...(out.get(g) ?? []), s]);
    }
    return [...out.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filter]);

  return (
    <div className="ai-sessions" role="dialog" aria-label="Conversations">
      <div className="ai-sessions-head">
        <span className="ai-sessions-title">Conversations</span>
        <span className="ai-spacer" />
        <button className="ai-iconbtn" title="Refresh" aria-label="Refresh" onClick={onRefresh}><Icon name="history" /></button>
        <button className="ai-iconbtn" title="Close" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="ai-sessions-tools">
        <div className="ai-search">
          <Icon name="search" size={13} />
          <input ref={search} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search conversations" spellCheck={false} />
        </div>
        <button className="ai-btn primary small" onClick={onNew}><Icon name="plus" size={13} /> New</button>
      </div>
      <div className="ai-sessions-list">
        {items === null && <div className="ai-sessions-note">Loading…</div>}
        {items !== null && groups.length === 0 && <div className="ai-sessions-note">{filter ? `Nothing matches “${filter}”.` : "No conversations yet. Start one — it will show up here."}</div>}
        {groups.map(([name, list]) => (
          <div key={name}>
            <div className="ai-sessions-group">{name}</div>
            {list.map((s) => (
              <div key={s.id} className={`ai-session${s.id === current ? " current" : ""}`} onClick={() => editing !== s.id && onOpen(s.id)}>
                {editing === s.id ? (
                  <input
                    className="ai-session-edit"
                    autoFocus
                    value={draft}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => setEditing(null)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && draft.trim()) (onRename(s.id, draft.trim()), setEditing(null));
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <>
                    {s.running && <span className="ai-dot run" title="Working" />}
                    <span className="ai-session-title" title={s.title}>{s.title}</span>
                    <span className="ai-session-time">{ago(s.updatedAt, now)}</span>
                    <span className="ai-session-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="ai-iconbtn" title="Rename" aria-label="Rename" onClick={() => (setDraft(s.title), setEditing(s.id))}><Icon name="edit" size={13} /></button>
                      {confirm === s.id ? (
                        <button className="ai-iconbtn danger" title="Click again to delete" onClick={() => (setConfirm(null), onDelete(s.id))}>Delete?</button>
                      ) : (
                        <button className="ai-iconbtn" title="Delete" aria-label="Delete" onClick={() => (setConfirm(s.id), window.setTimeout(() => setConfirm((c) => (c === s.id ? null : c)), 3000))}><Icon name="trash" size={13} /></button>
                      )}
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
