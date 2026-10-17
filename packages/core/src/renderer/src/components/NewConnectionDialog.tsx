import { useEffect, useState } from "react";
import type { ConnectionTypeContribution } from "@oneclient/plugin-api";
import type { ConnectionTypeFormInfo } from "../../../shared/types.js";
import { connectionLabel } from "../connection-label.js";
import { JsonSchemaForm } from "./JsonSchemaForm.js";

export function NewConnectionDialog({
  connectionTypes,
  onClose,
  onCreated,
}: {
  connectionTypes: Array<ConnectionTypeContribution & { pluginId: string }>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [typeId, setTypeId] = useState<string>("");
  const [form, setForm] = useState<ConnectionTypeFormInfo | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const picked = connectionTypes.filter((t) => !typeId || t.id === typeId);
  const noun = connectionLabel(picked.length ? picked : connectionTypes);
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error" | "ok"; message?: string }>({ kind: "idle" });

  // Opened from a single plugin's explorer — skip straight to its only type.
  useEffect(() => {
    const only = connectionTypes.length === 1 ? connectionTypes[0] : undefined;
    if (only) void pickType(only.id);
  }, []);

  async function pickType(id: string) {
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
      setConfig(Object.fromEntries(Object.entries(info.configSchema.properties ?? {}).flatMap(([key, p]) => (p.default !== undefined ? [[key, p.default]] : []))));
      setStatus({ kind: "idle" });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function test() {
    if (!typeId) return;
    setStatus({ kind: "busy" });
    try {
      const result = await window.oneclient.testConnection(typeId, config);
      setStatus(result.success ? { kind: "ok", message: result.message } : { kind: "error", message: result.message });
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function save() {
    if (!typeId || !name.trim()) return;
    setStatus({ kind: "busy" });
    try {
      await window.oneclient.createConnection(typeId, name.trim(), config);
      onCreated();
      onClose();
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{noun.one === "Connection" ? "New Connection" : `Add ${noun.one}`}</h2>

        <div className="form-field">
          <label htmlFor="conn-type">Type</label>
          <select id="conn-type" value={typeId} onChange={(e) => void pickType(e.target.value)}>
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
