import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteCommand {
  id: string;
  title: string;
  /** Dim text after the title (e.g. a theme's kind, or a keybinding). */
  description?: string;
  run: () => void;
}

/**
 * The command palette, also used as a generic quick pick (VS Code style):
 * e.g. the color-theme picker passes theme items, an `initialId` to start on
 * the current theme, and `onActiveChange` to preview whichever is highlighted.
 * `onClose(accepted)` tells the caller whether an item was chosen.
 */
export function CommandPalette({
  commands,
  onClose,
  placeholder = "Type a command…",
  initialId,
  onActiveChange,
}: {
  commands: PaletteCommand[];
  onClose: (accepted: boolean) => void;
  placeholder?: string;
  initialId?: string;
  onActiveChange?: (command: PaletteCommand) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => Math.max(0, commands.findIndex((c) => c.id === initialId)));
  const listRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.title.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setSelected(0);
  }, [query]);

  const active = filtered[selected];
  useEffect(() => {
    if (active) onActiveChange?.(active);
    (listRef.current?.children[selected] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  function accept(cmd: PaletteCommand | undefined) {
    if (!cmd) return;
    cmd.run();
    onClose(true);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      accept(active);
    }
  }

  return (
    <div className="palette-overlay" onMouseDown={() => onClose(false)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input autoFocus placeholder={placeholder} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} />
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && <div className="empty-hint">No matching items.</div>}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className={`palette-item ${i === selected ? "selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => accept(c)}
            >
              <span>{c.title}</span>
              {c.description && <span className="palette-description">{c.description}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
