import { useCallback, useEffect, useRef, useState } from "react";
import { ThemeIcon } from "../theme.js";
import { Logo } from "./Logo.js";

export interface MenuItem {
  id: string;
  label: string;
  /** Shortcut shown on the right ("Ctrl+Shift+P"). */
  accel?: string;
  run?: () => void;
  /** Default true. */
  enabled?: boolean;
  /** A check mark (toggles like View ▸ Appearance ▸ Side Bar). */
  checked?: boolean;
  submenu?: MenuItem[];
  /** Draw a separator above this item. */
  separator?: boolean;
}

export interface TopMenu {
  id: string;
  /** "&File" style: the letter after & is the Alt mnemonic (Alt+F). */
  label: string;
  items: MenuItem[];
}

const plain = (label: string) => label.replace("&", "");
const mnemonic = (label: string) => /&(\w)/.exec(label)?.[1]?.toLowerCase();
const isEnabled = (item: MenuItem) => item.enabled !== false && (item.run !== undefined || (item.submenu?.length ?? 0) > 0);

/**
 * The custom title bar: logo, the menu bar (File … Help), the search box in the middle, and room on the right for
 * the window buttons the OS draws over it. Empty space drags the window. Menus work with the mouse and the keyboard
 * (Alt+letter, arrows, Enter, Esc) like VS Code's.
 */
export function TitleBar({
  menus,
  onSearch,
  onOpenChange,
  onBeforeOpen,
}: {
  menus: TopMenu[];
  onSearch: () => void;
  /** A dropdown opened / closed — the shell hides its native view layers while one is open. */
  onOpenChange: (open: boolean) => void;
  /** Called on mouse-down on the menu bar, before focus moves (the Edit menu remembers what had focus). */
  onBeforeOpen: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; active: number } | null>(null);
  const [showMnemonics, setShowMnemonics] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());

  const openMenu = useCallback(
    (id: string | null, highlightFirst = false) => {
      setOpen(id);
      setSub(null);
      const menu = menus.find((m) => m.id === id);
      setActive(highlightFirst && menu ? menu.items.findIndex(isEnabled) : -1);
    },
    [menus],
  );

  useEffect(() => onOpenChange(open !== null), [open, onOpenChange]);

  // Close on a click outside, on window blur, or when the menus change under us.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".menu-dropdown")) openMenu(null);
    };
    const onBlur = () => openMenu(null);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, openMenu]);

  const run = (item: MenuItem) => {
    if (!isEnabled(item) || item.submenu) return;
    openMenu(null);
    // Let the dropdown close (and the native views come back) before the action runs.
    setTimeout(() => item.run?.(), 0);
  };

  // Keyboard: Alt+mnemonic opens a menu; with one open, arrows / Enter / Esc navigate it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        setShowMnemonics(e.type === "keydown");
        return;
      }
      if (e.type !== "keydown") return;
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        const m = menus.find((x) => mnemonic(x.label) === e.key.toLowerCase());
        if (m) {
          e.preventDefault();
          onBeforeOpen();
          openMenu(m.id, true);
          setShowMnemonics(false);
          return;
        }
      }
      if (!open) return;
      const menu = menus.find((m) => m.id === open);
      if (!menu) return;
      const items = sub ? (menu.items[sub.index]?.submenu ?? []) : menu.items;
      const current = sub ? sub.active : active;
      const move = (dir: 1 | -1) => {
        if (!items.length) return;
        let i = current;
        for (let n = 0; n < items.length; n++) {
          i = (i + dir + items.length) % items.length;
          if (isEnabled(items[i]!)) break;
        }
        if (sub) setSub({ ...sub, active: i });
        else setActive(i);
      };
      const switchMenu = (dir: 1 | -1) => {
        const i = menus.findIndex((m) => m.id === open);
        openMenu(menus[(i + dir + menus.length) % menus.length]!.id, true);
      };
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          if (sub) setSub(null);
          else openMenu(null);
          break;
        case "ArrowDown":
          e.preventDefault();
          move(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          move(-1);
          break;
        case "ArrowRight": {
          e.preventDefault();
          const item = !sub ? menu.items[active] : undefined;
          if (item?.submenu?.length) setSub({ index: active, active: item.submenu.findIndex(isEnabled) });
          else switchMenu(1);
          break;
        }
        case "ArrowLeft":
          e.preventDefault();
          if (sub) setSub(null);
          else switchMenu(-1);
          break;
        case "Enter":
        case " ": {
          e.preventDefault();
          const item = items[current];
          if (!item) break;
          if (item.submenu?.length && !sub) setSub({ index: current, active: item.submenu.findIndex(isEnabled) });
          else run(item);
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menus, open, active, sub, openMenu, onBeforeOpen]);

  const openRect = open ? buttonRefs.current.get(open)?.getBoundingClientRect() : undefined;
  const openMenuDef = menus.find((m) => m.id === open);

  return (
    <div className="titlebar" ref={barRef}>
      <div className="titlebar-left">
        <span className="titlebar-logo" title="oneClient">
          <Logo size={16} />
        </span>
        <div className="menubar" role="menubar" onMouseDown={(e) => (e.preventDefault(), onBeforeOpen())}>
          {menus.map((m) => (
            <button
              key={m.id}
              ref={(el) => {
                if (el) buttonRefs.current.set(m.id, el);
              }}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open === m.id}
              className={`menubar-item ${open === m.id ? "open" : ""}`}
              onMouseDown={() => openMenu(open === m.id ? null : m.id)}
              onMouseEnter={() => open && open !== m.id && openMenu(m.id)}
            >
              <MnemonicLabel label={m.label} show={showMnemonics || open !== null} />
            </button>
          ))}
        </div>
      </div>

      <button className="topbar-search" onClick={onSearch} title="Search files, SQL objects and more (Ctrl+P)">
        <ThemeIcon id="search" size={14} />
        <span>Search files, tables, procedures…</span>
        <kbd>Ctrl+P</kbd>
      </button>

      <div className="titlebar-right" />

      {openMenuDef && openRect && (
        <Dropdown
          items={openMenuDef.items}
          x={openRect.left}
          y={openRect.bottom}
          active={active}
          sub={sub}
          onHover={(i) => {
            setActive(i);
            const item = openMenuDef.items[i];
            setSub(item?.submenu?.length && isEnabled(item) ? { index: i, active: -1 } : null);
          }}
          onSubHover={(i) => sub && setSub({ ...sub, active: i })}
          onRun={run}
        />
      )}
    </div>
  );
}

function MnemonicLabel({ label, show }: { label: string; show: boolean }) {
  const i = label.indexOf("&");
  if (i === -1 || !show) return <>{plain(label)}</>;
  return (
    <>
      {label.slice(0, i)}
      <u>{label[i + 1]}</u>
      {label.slice(i + 2)}
    </>
  );
}

function Dropdown({
  items,
  x,
  y,
  active,
  sub,
  onHover,
  onSubHover,
  onRun,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  active: number;
  sub: { index: number; active: number } | null;
  onHover: (index: number) => void;
  onSubHover: (index: number) => void;
  onRun: (item: MenuItem) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [subTop, setSubTop] = useState(0);
  useEffect(() => {
    const w = ref.current?.offsetWidth ?? 0;
    setPos({ x: Math.max(0, Math.min(x, window.innerWidth - w - 4)), y });
  }, [x, y]);
  useEffect(() => {
    if (!sub) return;
    const row = ref.current?.querySelectorAll<HTMLElement>(":scope > .menu-row")[sub.index];
    setSubTop(row?.offsetTop ?? 0);
  }, [sub]);

  const subItems = sub ? items[sub.index]?.submenu : undefined;
  const width = ref.current?.offsetWidth ?? 0;
  const subLeft = pos.x + width + 220 > window.innerWidth ? -220 : width - 4;

  return (
    <div ref={ref} className="menu-dropdown" role="menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.preventDefault()}>
      {items.map((item, i) => (
        <MenuRow key={item.id} item={item} active={i === active} onHover={() => onHover(i)} onRun={() => onRun(item)} />
      ))}
      {subItems && (
        <div className="menu-dropdown menu-submenu" role="menu" style={{ left: subLeft, top: subTop - 4 }}>
          {subItems.length === 0 && <div className="menu-row disabled">(none)</div>}
          {subItems.map((item, i) => (
            <MenuRow key={item.id} item={item} active={i === sub?.active} onHover={() => onSubHover(i)} onRun={() => onRun(item)} />
          ))}
        </div>
      )}
    </div>
  );
}

function MenuRow({ item, active, onHover, onRun }: { item: MenuItem; active: boolean; onHover: () => void; onRun: () => void }) {
  const enabled = isEnabled(item);
  return (
    <>
      {item.separator && <div className="menu-separator" />}
      <div
        className={`menu-row ${active && enabled ? "active" : ""} ${enabled ? "" : "disabled"}`}
        role="menuitem"
        aria-disabled={!enabled}
        onMouseEnter={onHover}
        onClick={onRun}
      >
        <span className="menu-check">{item.checked ? "✓" : ""}</span>
        <span className="menu-label">{item.label}</span>
        <span className="menu-accel">{item.submenu ? "›" : (item.accel ?? "")}</span>
      </div>
    </>
  );
}
