import { type ReactElement, useState } from "react";
import type { JsonSchemaObject } from "@oneclient/plugin-api";
import { JsonSchemaForm } from "./JsonSchemaForm.js";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}
interface InputOptions {
  title: string;
  schema: JsonSchemaObject;
  initial: Record<string, unknown>;
}

/**
 * Promise-style dialogs: `await prompts.confirm(...)` / `await prompts.input(...)`.
 * Render `prompts.element` somewhere in the tree; it's null when no dialog is open.
 */
export function usePrompts() {
  const [element, setElement] = useState<ReactElement | null>(null);

  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        setElement(null);
        resolve(ok);
      };
      setElement(<ConfirmDialog {...options} onConfirm={() => done(true)} onCancel={() => done(false)} />);
    });
  }

  function input(options: InputOptions): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const done = (values: Record<string, unknown> | null) => {
        setElement(null);
        resolve(values);
      };
      setElement(<CommandInputDialog {...options} onSubmit={(v) => done(v)} onCancel={() => done(null)} />);
    });
  }

  return { element, confirm, input };
}

/** Collects a command's `inputSchema` answers before it runs. */
export function CommandInputDialog({
  title,
  schema,
  initial,
  onSubmit,
  onCancel,
}: {
  title: string;
  schema: JsonSchemaObject;
  initial: Record<string, unknown>;
  onSubmit: (values: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initial);
  const missing = (schema.required ?? []).some((key) => {
    const v = values[key];
    return v === undefined || v === null || (typeof v === "string" && !v.trim());
  });

  return (
    <div className="dialog-overlay" onMouseDown={onCancel}>
      <form
        className="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!missing) onSubmit(values);
        }}
      >
        <h2>{title}</h2>
        <JsonSchemaForm schema={schema} value={values} onChange={setValues} autoFocus />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={missing}>
            OK
          </button>
        </div>
      </form>
    </div>
  );
}

/** In-app confirmation (native `confirm()` would block the whole renderer). */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "OK",
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="dialog-overlay" onMouseDown={onCancel}>
      <div
        className="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2>{title}</h2>
        <p style={{ margin: "0 0 4px", whiteSpace: "pre-wrap" }}>{message}</p>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
