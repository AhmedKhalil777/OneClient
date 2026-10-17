import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

// Small shared pieces for the Kafka pages: the API call, query params, dialogs and toasts.

export const qs = new URLSearchParams(location.search);
export const connectionId = qs.get("connectionId") ?? "";

export type Res<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

/** Calls the plugin backend's `kafka.api` dispatcher (src/api.ts). Never throws. */
export async function api<T = Json>(method: string, params: Record<string, unknown> = {}): Promise<Res<T>> {
  try {
    return (await window.oneclientView.invokeCommand("kafka.api", [{ connectionId, method, params }])) as Res<T>;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export const open = (viewId: string, title: string, params: Record<string, string>, icon?: string) =>
  window.oneclientView.openView({ viewId, title, params, ...(icon ? { icon } : {}) });


export const fmtTime = (ms: number) => (ms ? new Date(ms).toLocaleString() : "");
export const fmtNum = (n: number) => n.toLocaleString();

// ---- toast -------------------------------------------------------------------------------------------------------

export function useToast(): [ReactNode, (text: string, isError?: boolean) => void] {
  const [toast, setToast] = useState<{ text: string; err: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((text: string, isError = false) => {
    setToast({ text, err: isError });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), isError ? 8000 : 3500);
  }, []);
  return [toast ? <div className={`kc-toast${toast.err ? " err" : ""}`}>{toast.text}</div> : null, show];
}

// ---- modal -------------------------------------------------------------------------------------------------------

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="kc-modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="kc-modal" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export interface Field {
  key: string;
  label: string;
  type?: "text" | "password" | "checkbox" | "textarea";
  required?: boolean;
  value?: string | boolean;
  placeholder?: string;
}

/** A form dialog. `onSubmit` returns an error message to keep the dialog open, or nothing to close it. */
export function FormDialog({
  title,
  fields,
  submitLabel = "OK",
  onSubmit,
  onClose,
}: {
  title: string;
  fields: Field[];
  submitLabel?: string;
  onSubmit: (values: Record<string, string | boolean>) => Promise<string | void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value ?? (f.type === "checkbox" ? false : "")])));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const missing = fields.some((f) => f.required && !String(values[f.key] ?? "").trim());

  const submit = async () => {
    if (missing || busy) return;
    setBusy(true);
    const err = await onSubmit(values);
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <Modal title={title} onClose={onClose}>
      {fields.map((f, i) => (
        <div className="kc-field" key={f.key}>
          {f.type === "checkbox" ? (
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={Boolean(values[f.key])} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} /> {f.label}
            </label>
          ) : (
            <>
              <label>
                {f.label}
                {f.required ? " *" : ""}
              </label>
              {f.type === "textarea" ? (
                <textarea className="kc-textarea" value={String(values[f.key])} placeholder={f.placeholder} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
              ) : (
                <input
                  className="kc-input"
                  type={f.type ?? "text"}
                  autoFocus={i === 0}
                  value={String(values[f.key])}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && void submit()}
                />
              )}
            </>
          )}
        </div>
      ))}
      {error && <div className="kc-error">{error}</div>}
      <div className="kc-row" style={{ justifyContent: "flex-end" }}>
        <button className="oce-btn" onClick={onClose}>
          Cancel
        </button>
        <button className="oce-btn oce-btn-primary" disabled={missing || busy} onClick={() => void submit()}>
          {submitLabel}
        </button>
      </div>
    </Modal>
  );
}

export function ConfirmDialog({ title, text, confirmLabel = "Delete", onConfirm, onClose }: { title: string; text: string; confirmLabel?: string; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div>{text}</div>
      <div className="kc-row" style={{ justifyContent: "flex-end" }}>
        <button className="oce-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="oce-btn oce-btn-primary"
          autoFocus
          onClick={async () => {
            await onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export const copy = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

export function Badge({ on, yes = "enabled", no = "disabled" }: { on: boolean; yes?: string; no?: string }) {
  return <span className={`kc-badge${on ? "" : " off"}`}>{on ? yes : no}</span>;
}
