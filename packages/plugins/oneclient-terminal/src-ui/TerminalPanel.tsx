import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import { getTheme, onThemeChange } from "@oneclient/editor-kit";
import { Icon } from "@oneclient/editor-kit/react";

interface SessionInfo {
  id: string;
  title: string;
  profileId: string;
  cwd: string;
  replay?: string;
}
type ToView =
  | { type: "state"; profiles: Array<{ id: string; name: string }>; sessions: SessionInfo[] }
  | { type: "created"; session: SessionInfo; focus: boolean }
  | { type: "data"; id: string; data: string }
  | { type: "exit"; id: string; code: number };

const post = (message: unknown) => window.oneclientView.postMessage(message);

/** xterm.js palette from the active oneClient theme's terminal.* colors (fallbacks = Dark+). */
function xtermTheme(colors: Readonly<Record<string, string>> = {}): ITheme {
  const c = (key: string, fallback: string) => colors[key] ?? fallback;
  return {
    background: c("terminal.background", "#1e1e1e"),
    foreground: c("terminal.foreground", "#cccccc"),
    cursor: c("terminalCursor.foreground", "#aeafad"),
    selectionBackground: c("terminal.selectionBackground", "#264f78"),
    black: c("terminal.ansiBlack", "#000000"),
    red: c("terminal.ansiRed", "#cd3131"),
    green: c("terminal.ansiGreen", "#0dbc79"),
    yellow: c("terminal.ansiYellow", "#e5e510"),
    blue: c("terminal.ansiBlue", "#2472c8"),
    magenta: c("terminal.ansiMagenta", "#bc3fbc"),
    cyan: c("terminal.ansiCyan", "#11a8cd"),
    white: c("terminal.ansiWhite", "#e5e5e5"),
    brightBlack: c("terminal.ansiBrightBlack", "#666666"),
    brightRed: c("terminal.ansiBrightRed", "#f14c4c"),
    brightGreen: c("terminal.ansiBrightGreen", "#23d18b"),
    brightYellow: c("terminal.ansiBrightYellow", "#f5f543"),
    brightBlue: c("terminal.ansiBrightBlue", "#3b8eea"),
    brightMagenta: c("terminal.ansiBrightMagenta", "#d670d6"),
    brightCyan: c("terminal.ansiBrightCyan", "#29b8db"),
    brightWhite: c("terminal.ansiBrightWhite", "#e5e5e5"),
  };
}

interface Live {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
}

/**
 * The Terminal panel: one xterm.js instance per shell session (all kept
 * alive, only the active one shown) and a session list on the right, like
 * VS Code. Shells run in the plugin backend; this view only renders them.
 */
export function TerminalPanel() {
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string>("");
  const live = useRef(new Map<string, Live>());
  const stage = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = active;

  // ---- xterm instances ----
  function mount(session: SessionInfo) {
    if (live.current.has(session.id) || !stage.current) return;
    const host = document.createElement("div");
    host.className = "term-host";
    host.hidden = true;
    stage.current.appendChild(host);

    const term = new Terminal({
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 14,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: xtermTheme(getTheme()?.colors),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    if (session.replay) term.write(session.replay);

    term.onData((data) => post({ type: "input", id: session.id, data }));
    term.onResize(({ cols, rows }) => post({ type: "resize", id: session.id, cols, rows }));
    // Ctrl+C copies when there's a selection (otherwise it's ^C for the shell); Ctrl+V pastes natively.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "c" && term.hasSelection()) {
        copyText(term.getSelection());
        term.clearSelection();
        return false;
      }
      // Physical key: with Shift held, the backtick key reports "~".
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.code === "Backquote") {
        newTerminal();
        return false;
      }
      return true;
    });

    live.current.set(session.id, { term, fit, host });
  }

  function show(id: string | null) {
    for (const [sid, l] of live.current) l.host.hidden = sid !== id;
    setActive(id);
    if (!id) return;
    const l = live.current.get(id);
    if (l) {
      requestAnimationFrame(() => {
        safeFit(l);
        l.term.focus();
      });
    }
  }

  function dispose(id: string) {
    const l = live.current.get(id);
    if (!l) return;
    l.term.dispose();
    l.host.remove();
    live.current.delete(id);
  }

  function newTerminal(profile = profileId) {
    const l = activeRef.current ? live.current.get(activeRef.current) : undefined;
    post({ type: "create", profileId: profile || undefined, cols: l?.term.cols, rows: l?.term.rows });
  }

  // ---- backend messages ----
  useEffect(() => {
    const off = window.oneclientView.onMessage((raw) => {
      const msg = raw as ToView;
      switch (msg.type) {
        case "state": {
          setProfiles(msg.profiles);
          setProfileId((p) => p || msg.profiles[0]?.id || "");
          setSessions(msg.sessions);
          msg.sessions.forEach(mount);
          if (msg.sessions.length === 0) post({ type: "create" });
          else show(msg.sessions[msg.sessions.length - 1]!.id);
          break;
        }
        case "created":
          mount(msg.session);
          setSessions((s) => [...s.filter((x) => x.id !== msg.session.id), msg.session]);
          if (msg.focus || !activeRef.current) show(msg.session.id);
          break;
        case "data":
          live.current.get(msg.id)?.term.write(msg.data);
          break;
        case "exit": {
          dispose(msg.id);
          setSessions((s) => {
            const rest = s.filter((x) => x.id !== msg.id);
            if (activeRef.current === msg.id) show(rest[rest.length - 1]?.id ?? null);
            return rest;
          });
          break;
        }
      }
    });
    post({ type: "hello" });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow theme switches live.
  useEffect(
    () =>
      onThemeChange((theme) => {
        for (const l of live.current.values()) l.term.options.theme = xtermTheme(theme.colors);
      }),
    [],
  );

  // Refit the visible terminal whenever the panel is resized (or shown again after being hidden).
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const l = activeRef.current ? live.current.get(activeRef.current) : undefined;
      if (l) safeFit(l);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const current = sessions.find((s) => s.id === active);

  return (
    <div className="terminal-panel">
      <div className="term-stage" ref={stage}>
        {sessions.length === 0 && <div className="term-empty">No open terminals. Press + to start one.</div>}
      </div>
      <div className="term-side">
        <div className="term-toolbar">
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)} title="Shell for new terminals">
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button title="New Terminal (Ctrl+Shift+`)" onClick={() => newTerminal()}>
            <Icon id="add" />
          </button>
          <button title="Kill Terminal" disabled={!current} onClick={() => current && post({ type: "kill", id: current.id })}>
            <Icon id="trash" />
          </button>
          <button title="Clear" disabled={!current} onClick={() => current && live.current.get(current.id)?.term.clear()}>
            <Icon id="close" />
          </button>
        </div>
        <div className="term-list">
          {sessions.map((s, i) => (
            <div
              key={s.id}
              className={`term-item ${s.id === active ? "active" : ""}`}
              title={s.cwd}
              onClick={() => show(s.id)}
            >
              <Icon id="terminal" className="term-glyph" />
              <span className="term-title">
                {i + 1}: {s.title}
              </span>
              <button
                className="term-kill"
                title="Kill"
                onClick={(e) => {
                  e.stopPropagation();
                  post({ type: "kill", id: s.id });
                }}
              >
                <Icon id="close" size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function safeFit(l: Live) {
  // fit() throws/no-ops while the element has no size (panel hidden).
  if (l.host.clientWidth > 0 && l.host.clientHeight > 0) {
    try {
      l.fit.fit();
    } catch {
      /* ignore */
    }
  }
}

/** execCommand works in the sandboxed view without clipboard permissions (it's a user gesture). */
function copyText(text: string) {
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  document.execCommand("copy");
  el.remove();
}
