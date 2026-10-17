import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  id: string;
  label: string;
  run: () => void;
  danger?: boolean;
  /** Draw a separator above this item. */
  separator?: boolean;
}

/** A VS Code-style right-click menu at viewport coordinates; closes on outside click, Escape, blur, or after running an item. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Keep the menu fully on screen (flip left/up near the window edges).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: x + width > window.innerWidth ? Math.max(0, x - width) : x,
      y: y + height > window.innerHeight ? Math.max(0, y - height) : y,
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item) => (
        <div key={item.id}>
          {item.separator && <div className="context-menu-separator" />}
          <div
            className={`context-menu-item ${item.danger ? "danger" : ""}`}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.label}
          </div>
        </div>
      ))}
    </div>
  );
}
