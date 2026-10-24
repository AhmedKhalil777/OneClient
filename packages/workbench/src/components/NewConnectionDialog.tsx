import { useEffect, useState } from "react";
import type { ConnectionTypeContribution } from "@oneclient/plugin-api";
import type { ConnectionTypeFormInfo } from "@oneclient/backend/shared/types.js";
import type { ConnectionForEdit } from "@oneclient/backend/shared/ipc-contract.js";
import { connectionLabel } from "../connection-label.js";
import { JsonSchemaForm } from "./JsonSchemaForm.js";

/** New connection, or — with `editId` — edit a saved one in place (same id, so open tabs and secrets stay). */
export function NewConnectionDialog({
  connectionTypes,
  onClose,
  onCreated,
  editId,
}: {
  connectionTypes: Array<ConnectionTypeContribution & { pluginId: string }>;
  onClose: () => void;
  onCreated: () => void;
  editId?: string;
}) {
  const [editing, setEditing] = useState<ConnectionForEdit | null>(null);
  const [typeId, setTypeId] = useState<string>("");
  const [form, setForm] = useState<ConnectionTypeFormInfo | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const picked = connectionTypes.filter((t) => !typeId || t.id === typeId);
  const noun = connectionLabel(picked.length ? picked : connectionTypes);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error" | "ok"; message?: string }>({ kind: "idle" });

  // Editing: load the saved settings. Otherwise, opened from a single plugin's explorer — skip to its only type.
  useEffect(() => {
    if (editId) {
      void (async () => {
        try {
          const saved = await window.oneclient.getConnectionForEdit(editId);
          setEditing(saved);
          setName(saved.name);
          setNameTouched(true);
          await pickType(saved.typeId, saved.config);
        } catch (err) {
          setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        }
      })();
      return;
    }
    const only = connectionTypes.length === 1 ? connectionTypes[0] : undefined;
    if (only) void pickType(only.id);
  }, []);

  async function pickType(id: string, initial?: Record<string, unknown>) {
    setTypeId(id);
    setForm(null);
    setConfig({});
    setStatus({ kind: "idle" });
    if (!id) return;
    setStatus({ kind: "busy" });
    try {
      const info = await window.oneclient.getConnectionForm(id);
      setForm(info);
      // The form shows each field's schema default; start from them so what's shown is what gets saved.
      const defaults = Object.fromEntries(Object.entries(info.configSchema.properties ?? {}).flatMap(([key, p]) => (p.default !== undefined ? [[key, p.default]] : [])));
      setConfig({ ...defaults, ...(initial ?? {}) });
      setStatus({ kind: "idle" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function test() {
    if (!typeId) return;
    setStatus({ kind: "busy" });
    try {
      const result = editing ? await window.oneclient.testExistingConnection(editing.id, config) : await window.oneclient.testConnection(typeId, config);
      setStatus(result.success ? { kind: "ok", message: result.message } : { kind: "error", message: result.message });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function save() {
    if (!typeId || !name.trim()) return;
    setStatus({ kind: "busy" });
    try {
      if (editing) await window.oneclient.updateConnection(editing.id, name.trim(), config);
      else await window.oneclient.createConnection(typeId, name.trim(), config);
      onCreated();
      onClose();
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{editing ? `Edit ${noun.one}` : noun.one === "Connection" ? "New Connection" : `Add ${noun.one}`}</h2>

        <div className="form-field">
          <label htmlFor="conn-type">Type</label>
          <select id="conn-type" value={typeId} disabled={!!editId} onChange={(e) => void pickType(e.target.value)}>
            <option value="" disabled>
              Select a connection type…
            </option>
            {connectionTypes.map((t) => (
              <option key={`${t.pluginId}:${t.id}`} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        {form && (
          <>
            <div className="form-field">
              <label htmlFor="conn-name">Name</label>
              <input id="conn-name" value={name} onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                placeholder={`My ${noun.one.toLowerCase()}`}
              />
            </div>
            {editing && form && <SecretsNote editing={editing} form={form} />}
            <JsonSchemaForm
              schema={form.configSchema}
              value={config}
              onChange={(next) => {
                // The connection is named after the chosen folder until the user types a name themselves.
                if (!nameTouched) {
                  const dirKey = Object.entries(form.configSchema.properties ?? {}).find(([, p]) => p.format === "directory")?.[0];
                  const dir = dirKey ? next[dirKey] : undefined;
                  if (typeof dir === "string" && dir) setName(dir.split(/[\\/]/).filter(Boolean).pop() ?? dir);
                }
                setConfig(next);
              }}
            />
          </>
        )}

        {status.kind === "error" && <div style={{ color: "var(--danger)" }}>{status.message}</div>}
        {status.kind === "ok" && <div style={{ color: "var(--ok)" }}>{status.message ?? `${noun.one} OK`}</div>}

        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!form || status.kind === "busy"} onClick={() => void test()}>
            Test
          </button>
          <button
            className="btn btn-primary"
            disabled={!form || !name.trim() || status.kind === "busy"}
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** Which secrets the form keeps, and which this app still needs (the desktop app and the web server store their own). */
function SecretsNote({ editing, form }: { editing: ConnectionForEdit; form: ConnectionTypeFormInfo }) {
  const title = (key: string) => (form.configSchema.properties?.[key]?.title ?? key).toLowerCase();
  const list = (keys: string[]) => keys.map(title).join(", ");
  if (editing.savedSecrets.length === 0 && editing.missingSecrets.length === 0) return null;
  return (
    <div className="form-note">
      {editing.savedSecrets.length > 0 && <div>Saved {list(editing.savedSecrets)} — leave blank to keep it.</div>}
      {editing.missingSecrets.length > 0 && (
        <div className="form-note-warn">
          No {list(editing.missingSecrets)} saved in this app yet — the desktop app and the browser keep their passwords separately. Enter it if this
          connection needs one.
        </div>
      )}
    </div>
  );
}