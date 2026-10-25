import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, copyText } from "./icons.js";
import { Markdown } from "./markdown.js";
import { type ModelRow, ModelPicker } from "./ModelPicker.js";
import { type SessionItem, Sessions } from "./Sessions.js";

const newId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const initialId = new URLSearchParams(location.search).get("c") || newId();

interface Tool {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}
interface Item {
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  tools?: Tool[];
  /** Assistant message no longer streaming. */
  closed?: boolean;
}
interface Approval {
  id: string;
  name: string;
  summary: string;
}
interface Usage {
  input: number;
  output: number;
  cached?: number;
}

type Incoming =
  | { type: "init"; title: string; items: Item[]; usage: Usage; running: boolean; model: string; workspaceTools: boolean }
  | { type: "event"; event: { type: string; delta?: string; id?: string; name?: string; input?: Record<string, unknown>; content?: string; isError?: boolean; usage?: Usage } }
  | { type: "approval"; id: string; name: string; summary: string }
  | { type: "running"; running: boolean }
  | { type: "error"; message: string }
  | { type: "note"; text: string }
  | { type: "models"; rows: ModelRow[] }
  | { type: "list"; items: SessionItem[] }
  | { type: "export"; title: string; markdown: string };

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

const TOOL_LABEL: Record<string, string> = { list_files: "Looked at", read_file: "Read", search_files: "Searched", edit_file: "Edited", write_file: "Wrote", list_connections: "Listed connections" };

function toolTitle(t: Tool): string {
  const target = String(t.input.path ?? t.input.pattern ?? t.input.sql ?? t.input.filter ?? "");
  const fallback = ["list_files", "read_file", "search_files"].includes(t.name) ? "open folders" : "";
  return `${TOOL_LABEL[t.name] ?? t.name.replace(/_/g, " ")} ${(target || fallback).replace(/\s+/g, " ").slice(0, 80)}`.trim();
}

const SUGGESTIONS = ["Explain what this project does", "Find where connections are saved", "Write a SQL query for the top 10 customers by revenue", "Review my open folder for obvious bugs"];

export function Chat() {
  const [c, setC] = useState(initialId);
  const cRef = useRef(c);
  cRef.current = c;
  const [items, setItems] = useState<Item[]>([]);
  const [title, setTitle] = useState("New chat");
  const [workspaceTools, setWorkspaceTools] = useState(true);
  const [usage, setUsage] = useState<Usage>({ input: 0, output: 0 });
  const [running, setRunning] = useState(false);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState("");
  const [rows, setRows] = useState<ModelRow[] | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const [sessions, setSessions] = useState<SessionItem[] | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const exportIntent = useRef<"copy" | "download">("copy");

  const post = useCallback((m: Record<string, unknown>) => window.oneclientView.postMessage({ ...m, c: cRef.current }), []);
  const flash = useCallback((text: string) => {
    setNotice({ text, error: false });
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 2200);
  }, []);

  const onEvent = useCallback((e: Extract<Incoming, { type: "event" }>["event"]) => {
    setItems((prev) => {
      const next = prev.slice();
      const live = () => {
        const last = next[next.length - 1];
        if (last && last.role === "assistant" && !last.closed) return last;
        const fresh: Item = { role: "assistant", text: "", tools: [] };
        next.push(fresh);
        return fresh;
      };
      const lastAssistant = () => [...next].reverse().find((i) => i.role === "assistant");
      switch (e.type) {
        case "text": {
          const a = live();
          next[next.indexOf(a)] = { ...a, text: a.text + (e.delta ?? "") };
          break;
        }
        case "thinking": {
          const a = live();
          next[next.indexOf(a)] = { ...a, thinking: (a.thinking ?? "") + (e.delta ?? "") };
          break;
        }
        case "assistant_done": {
          const last = next[next.length - 1];
          if (last?.role === "assistant") next[next.length - 1] = { ...last, closed: true };
          break;
        }
        case "tool_start": {
          const a = lastAssistant();
          if (a) next[next.indexOf(a)] = { ...a, tools: [...(a.tools ?? []), { id: e.id ?? "", name: e.name ?? "", input: e.input ?? {} }] };
          break;
        }
        case "tool_end": {
          for (let i = next.length - 1; i >= 0; i--) {
            const a = next[i]!;
            if (a.tools?.some((t) => t.id === e.id)) {
              next[i] = { ...a, tools: a.tools.map((t) => (t.id === e.id ? { ...t, result: e.content ?? "", isError: e.isError ?? false } : t)) };
              break;
            }
          }
          break;
        }
      }
      return next;
    });
    if (e.type === "usage" && e.usage) setUsage(e.usage);
  }, []);

  useEffect(() => {
    const off = window.oneclientView.onMessage((raw) => {
      const m = raw as Incoming & { c?: string };
      if (m.c && m.c !== cRef.current) return;
      switch (m.type) {
        case "init":
          setItems(m.items.map((i) => ({ ...i, closed: true })));
          setTitle(m.title);
          setWorkspaceTools(m.workspaceTools);
          setModel(m.model);
          setUsage(m.usage);
          setRunning(m.running);
          break;
        case "event":
          onEvent(m.event);
          break;
        case "approval":
          setApprovals((a) => (a.some((x) => x.id === m.id) ? a : [...a, { id: m.id, name: m.name, summary: m.summary }]));
          break;
        case "running":
          setRunning(m.running);
          if (!m.running) {
            setApprovals([]);
            window.oneclientView.postMessage({ type: "list", c: cRef.current });
          }
          break;
        case "error":
          setNotice({ text: m.message, error: true });
          break;
        case "note":
          setNotice({ text: m.text, error: false });
          break;
        case "models":
          setRows(m.rows);
          break;
        case "list":
          setSessions(m.items);
          break;
        case "export":
          if (exportIntent.current === "copy") void copyText(m.markdown).then((ok) => flash(ok ? "Conversation copied as Markdown" : "Could not copy"));
          else {
            const url = URL.createObjectURL(new Blob([m.markdown], { type: "text/markdown" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `${m.title.replace(/[^\w.-]+/g, "-").slice(0, 60) || "conversation"}.md`;
            a.click();
            URL.revokeObjectURL(url);
          }
          break;
      }
    });
    post({ type: "init" });
    post({ type: "models" });
    post({ type: "list" });
    return off;
  }, [onEvent, post, flash]);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [items, approvals, running]);

  // Close the overflow menu on any outside click.
  useEffect(() => {
    if (!menu) return;
    const away = () => (setMenu(false), setConfirmDelete(false));
    const t = window.setTimeout(() => document.addEventListener("click", away), 0);
    return () => (window.clearTimeout(t), document.removeEventListener("click", away));
  }, [menu]);

  const grow = () => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  };
  useEffect(grow, [draft]);

  /** Switches to another conversation (or a fresh one) without leaving this tab. */
  const open = (id: string) => {
    if (id === cRef.current) return setDrawer(false);
    cRef.current = id;
    setC(id);
    setItems([]);
    setApprovals([]);
    setNotice(null);
    setUsage({ input: 0, output: 0 });
    setRunning(false);
    setTitle("New chat");
    setDrawer(false);
    stick.current = true;
    post({ type: "init" });
    window.setTimeout(() => input.current?.focus(), 50);
  };

  const send = (text = draft) => {
    const t = text.trim();
    if (!t || running) return;
    setNotice(null);
    stick.current = true;
    if (items.length === 0) setTitle(t.replace(/\s+/g, " ").slice(0, 60));
    setItems((i) => [...i, { role: "user", text: t, closed: true }]);
    setDraft("");
    post({ type: "send", text: t, model });
  };

  const answer = (id: string, allow: boolean) => {
    setApprovals((a) => a.filter((x) => x.id !== id));
    post({ type: "approve", id, allow });
  };

  const current = rows?.find((r) => `${r.provider}/${r.id}` === model);
  const cost = current?.priceIn !== undefined && current.priceOut !== undefined ? (usage.input * current.priceIn + usage.output * current.priceOut) / 1e6 : null;
  const total = usage.input + usage.output;

  return (
    <div className="ai-root">
      <header className="ai-head">
        <button className="ai-iconbtn" title="Conversations" aria-label="Conversations" onClick={() => (setDrawer((d) => !d), post({ type: "list" }))}><Icon name="history" /></button>
        {renaming ? (
          <input
            className="ai-title-edit"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => setRenaming(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && titleDraft.trim()) (setTitle(titleDraft.trim()), post({ type: "rename", text: titleDraft.trim() }), setRenaming(false));
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <button className="ai-title" title="Rename" onClick={() => items.length && (setTitleDraft(title), setRenaming(true))}>{title}</button>
        )}
        <span className="ai-spacer" />
        {total > 0 && (
          <span className="ai-chip" title={`${usage.input} input tokens${usage.cached ? ` (${usage.cached} from cache)` : ""}, ${usage.output} output tokens${cost === null ? " — no price known for this model, so no cost estimate" : ""}`}>
            {fmt(total)} tokens{cost !== null ? ` · ≈$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : ""}
          </span>
        )}
        <button className="ai-iconbtn" title="New chat" aria-label="New chat" onClick={() => open(newId())}><Icon name="plus" /></button>
        <div className="ai-menuwrap">
          <button className="ai-iconbtn" title="More" aria-label="More" onClick={(e) => (e.stopPropagation(), setMenu((m) => !m))}><Icon name="more" /></button>
          {menu && (
            <div className="ai-menu" onClick={(e) => e.stopPropagation()}>
              <button disabled={!items.length} onClick={() => (exportIntent.current = "copy", post({ type: "export" }), setMenu(false))}><Icon name="copy" size={13} /> Copy as Markdown</button>
              <button disabled={!items.length} onClick={() => (exportIntent.current = "download", post({ type: "export" }), setMenu(false))}><Icon name="download" size={13} /> Download .md</button>
              <button disabled={!items.length} onClick={() => (setTitleDraft(title), setRenaming(true), setMenu(false))}><Icon name="edit" size={13} /> Rename</button>
              <label className="ai-menu-check"><input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} /> Show thinking</label>
              <hr />
              <button
                className="danger"
                disabled={!items.length}
                onClick={() => {
                  if (!confirmDelete) return setConfirmDelete(true);
                  post({ type: "delete" });
                  setMenu(false);
                  setConfirmDelete(false);
                  open(newId());
                }}
              >
                <Icon name="trash" size={13} /> {confirmDelete ? "Click again to delete" : "Delete conversation"}
              </button>
            </div>
          )}
        </div>
      </header>

      {drawer && (
        <Sessions
          items={sessions}
          current={c}
          onOpen={open}
          onNew={() => open(newId())}
          onClose={() => setDrawer(false)}
          onRefresh={() => post({ type: "list" })}
          onRename={(id, t) => window.oneclientView.postMessage({ type: "rename", c: id, text: t })}
          onDelete={(id) => {
            window.oneclientView.postMessage({ type: "delete", c: id });
            if (id === c) open(newId());
          }}
        />
      )}

      <div
        className="ai-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stick.current = near;
          setAtBottom(near);
        }}
      >
        <div className="ai-thread">
          {items.length === 0 && (
            <div className="ai-empty">
              <div className="ai-logo"><Icon name="sparkle" size={22} /></div>
              <h2>How can I help?</h2>
              <p>{workspaceTools ? "I can read your open folders and your databases, and propose changes — you approve each one." : "Plain chat. File access is turned off on this connection."}</p>
              <div className="ai-suggest">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => (setDraft(s), input.current?.focus())}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {items.map((item, i) => (
            <div key={i} className={`ai-msg ai-${item.role}`}>
              {item.role === "assistant" && <div className="ai-avatar"><Icon name="sparkle" size={12} /></div>}
              <div className="ai-body">
                {item.role === "assistant" && showThinking && item.thinking && (
                  <details open className="ai-thinking">
                    <summary><Icon name="think" size={13} /> Thinking</summary>
                    <div>{item.thinking}</div>
                  </details>
                )}
                {item.tools?.length ? (
                  <div className="ai-tools">
                    {item.tools.map((t) => (
                      <details key={t.id} className={`ai-tool${t.isError ? " err" : ""}`}>
                        <summary>
                          <span className={`ai-dot${t.result === undefined ? " run" : t.isError ? " bad" : " ok"}`} />
                          <span className="ai-tool-title">{toolTitle(t)}</span>
                        </summary>
                        {t.name === "edit_file" && <pre>{`- ${String(t.input.old_text ?? "")}\n+ ${String(t.input.new_text ?? "")}`}</pre>}
                        {t.name === "write_file" && <pre>{String(t.input.content ?? "").slice(0, 2000)}</pre>}
                        {typeof t.input.sql === "string" && <pre>{t.input.sql}</pre>}
                        {t.result !== undefined && <pre>{t.result.slice(0, 3000)}</pre>}
                      </details>
                    ))}
                  </div>
                ) : null}
                {item.role === "user" ? (
                  <div className="ai-bubble">{item.text}</div>
                ) : (
                  item.text && (
                    <div className="ai-text">
                      <Markdown text={item.text} />
                    </div>
                  )
                )}
                {item.text && item.closed && (
                  <div className="ai-actions">
                    <button className="ai-iconbtn" title="Copy" aria-label="Copy" onClick={() => void copyText(item.text).then(() => flash("Copied"))}><Icon name="copy" size={13} /></button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {approvals.map((a) => (
            <div key={a.id} className="ai-approve">
              <div className="ai-approve-title">{a.name === "edit_file" ? "Approve this edit?" : a.name === "write_file" ? "Approve this file change?" : "Approve this action?"}</div>
              <pre>{a.summary}</pre>
              <div className="ai-approve-row">
                <button className="ai-btn primary" onClick={() => answer(a.id, true)}>Approve</button>
                <button className="ai-btn" onClick={() => answer(a.id, false)}>Decline</button>
              </div>
            </div>
          ))}
          {running && approvals.length === 0 && (
            <div className="ai-typing" aria-label="Working">
              <span /> <span /> <span />
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>

      {!atBottom && (
        <button className="ai-jump" title="Jump to latest" aria-label="Jump to latest" onClick={() => (stick.current = true, bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }))}>
          <Icon name="down" />
        </button>
      )}
      {notice && <div className={`ai-toast${notice.error ? " err" : ""}`} onClick={() => setNotice(null)}>{notice.text}</div>}

      <div className="ai-composer-wrap">
        <div className="ai-composer">
          <textarea
            ref={input}
            value={draft}
            placeholder={running ? "Working… you can already type your next message" : "Ask anything — Enter to send, Shift+Enter for a new line"}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="ai-composer-bar">
            <ModelPicker value={model} rows={rows} onOpen={(refresh) => post({ type: "models", refresh })} onPick={setModel} />
            <span className="ai-spacer" />
            {running ? (
              <button className="ai-send stop" title="Stop" aria-label="Stop" onClick={() => post({ type: "stop" })}><Icon name="stop" size={14} /></button>
            ) : (
              <button className="ai-send" title="Send" aria-label="Send" disabled={!draft.trim()} onClick={() => send()}><Icon name="send" size={14} /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
