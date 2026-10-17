import { useEffect, useRef, useState } from "react";
import type { DocumentSymbol, DocumentSymbolKind } from "@oneclient/plugin-api";
import { siblingsAt } from "./lib/symbols.js";

const GLYPH: Record<DocumentSymbolKind, string> = {
  object: "{}",
  array: "[]",
  string: "ab",
  number: "12",
  boolean: "tf",
  null: "∅",
  property: "·",
  element: "<>",
  heading: "#",
  other: "·",
};

const MAX_LISTED = 400;

function Glyph({ kind }: { kind: DocumentSymbolKind }) {
  return <span className={`glyph glyph-${kind}`}>{GLYPH[kind]}</span>;
}

/**
 * VS Code-style breadcrumbs: the file's folders and name, then the structure around the cursor
 * (`users › [3] › name`). Clicking a symbol segment lists its siblings; picking one jumps there.
 */
export function Breadcrumbs({
  filePath,
  path,
  symbols,
  onGoTo,
}: {
  filePath: string;
  path: readonly DocumentSymbol[];
  symbols: readonly DocumentSymbol[];
  onGoTo: (symbol: DocumentSymbol) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The path changes as the cursor moves; a dropdown for a segment that no longer exists must not linger.
  useEffect(() => {
    if (open !== null && open >= path.length) setOpen(null);
  }, [path.length, open]);

  const folders = filePath.split("/");
  return (
    <div className="breadcrumbs" ref={rootRef}>
      {folders.map((part, i) => (
        <span key={`f${i}`} className="crumb-wrap">
          <span className={`crumb crumb-file ${i === folders.length - 1 ? "last" : ""}`}>{part}</span>
          {(i < folders.length - 1 || path.length > 0) && <span className="crumb-sep">›</span>}
        </span>
      ))}
      {path.map((symbol, i) => {
        const siblings = siblingsAt(symbols, path, i);
        return (
          <span key={`s${i}`} className="crumb-wrap">
            <button className={`crumb crumb-symbol ${open === i ? "open" : ""}`} onClick={() => setOpen(open === i ? null : i)} title={symbol.detail ? `${symbol.name} — ${symbol.detail}` : symbol.name}>
              <Glyph kind={symbol.kind} />
              {symbol.name}
            </button>
            {i < path.length - 1 && <span className="crumb-sep">›</span>}
            {open === i && (
              <div className="crumb-menu" role="listbox">
                {siblings.slice(0, MAX_LISTED).map((s, k) => (
                  <div
                    key={k}
                    role="option"
                    aria-selected={s.start === symbol.start && s.end === symbol.end}
                    className={`crumb-item ${s.start === symbol.start && s.end === symbol.end ? "current" : ""}`}
                    onClick={() => {
                      setOpen(null);
                      onGoTo(s);
                    }}
                  >
                    <Glyph kind={s.kind} />
                    <span className="crumb-item-name">{s.name}</span>
                    {s.detail && <span className="crumb-item-detail">{s.detail}</span>}
                  </div>
                ))}
                {siblings.length > MAX_LISTED && <div className="crumb-more">… {siblings.length - MAX_LISTED} more</div>}
              </div>
            )}
          </span>
        );
      })}
    </div>
  );
}
