import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { friendlyError } from "../src/aggregate/model.js";

/** Small pieces the Fast Aggregate screens share: in-app confirmations, friendly errors, Esc and autofocus. */

export interface Choice {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

export interface ChooseOptions {
  title: string;
  message?: ReactNode;
  choices: Choice[];
}

/** Asks the user to pick one button; resolves to its id, or null when dismissed (Esc / click outside). */
export type Choose = (options: ChooseOptions) => Promise<string | null>;

export const ChooseContext = createContext<Choose>(async () => null);
export const useChoose = (): Choose => useContext(ChooseContext);

/** An in-app replacement for `window.confirm`: the dialog element to render, and the function that opens it. */
export function useChooser(): [ReactNode, Choose] {
  const [open, setOpen] = useState<{ options: ChooseOptions; resolve: (id: string | null) => void } | null>(null);
  const choose = useCallback<Choose>((options) => new Promise((resolve) => setOpen({ options, resolve })), []);
  const close = (id: string | null) => {
    open?.resolve(id);
    setOpen(null);
  };
  useEscape(open ? () => close(null) : null);
  const primary = open?.options.choices.find((c) => c.primary) ?? open?.options.choices[0];
  const element = open ? (
    <div className="agg-overlay confirm" role="alertdialog" aria-modal="true" aria-label={open.options.title} onMouseDown={(e) => e.target === e.currentTarget && close(null)}>
      <div className="agg-dialog confirm">
        <h3>{open.options.title}</h3>
        {open.options.message && <div className="agg-confirm-body">{open.options.message}</div>}
        <div className="agg-formbar">
          {open.options.choices.map((c) => (
            <button key={c.id} autoFocus={c.id === primary?.id} className={`agg-btn${c.primary ? " primary" : ""}${c.danger ? " danger-fill" : ""}`} onClick={() => close(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  ) : null;
  return [element, choose];
}

/** Open dialogs, outermost first: Escape goes to the last one only. */
const escapeStack: Array<{ current: (() => void) | null }> = [];
let escapeInstalled = false;
function installEscape() {
  if (escapeInstalled) return;
  escapeInstalled = true;
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const top = escapeStack[escapeStack.length - 1];
      if (!top?.current) return;
      e.preventDefault();
      e.stopPropagation();
      top.current();
    },
    true,
  );
}

/** Runs `handler` when Escape is pressed (nothing while `handler` is null). With dialogs on top of dialogs, only the top one reacts. */
export function useEscape(handler: (() => void) | null): void {
  const ref = useRef<(() => void) | null>(handler);
  ref.current = handler;
  const active = handler !== null;
  useEffect(() => {
    if (!active) return;
    installEscape();
    escapeStack.push(ref);
    return () => {
      const i = escapeStack.lastIndexOf(ref);
      if (i >= 0) escapeStack.splice(i, 1);
    };
  }, [active]);
}

/** Focuses the first editable field of a dialog when it opens. */
export function useAutofocus(container: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = container.current?.querySelector<HTMLElement>("input:not([disabled]):not([type=checkbox]), textarea:not([disabled]), select:not([disabled])");
    el?.focus();
  }, [container]);
}

/** A database error as a sentence a user can act on, with the database's own text behind "Details". */
export function ErrorBox({ message }: { message: string }) {
  const [open, setOpen] = useState(false);
  const f = friendlyError(message);
  const differs = f.detail.trim() !== f.summary.trim();
  return (
    <div className="agg-error" role="alert">
      <div>{f.summary}</div>
      {differs && (
        <>
          <button type="button" className="agg-link" onClick={() => setOpen(!open)}>
            {open ? "Hide details" : "Details"}
          </button>
          {open && <pre className="agg-detail">{f.detail}</pre>}
        </>
      )}
    </div>
  );
}
