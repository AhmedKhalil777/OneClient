import { useState } from "react";
import type { ConnectionTypeContribution } from "@oneclient/plugin-api";
import type { ConnectionTypeFormInfo } from "../../../shared/types.js";
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
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "error" | "ok"; message?: string }>({ kind: "idle" });

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
        <h2>New Connection</h2>

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
              <input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My connection" />
            </div>
            <JsonSchemaForm schema={form.configSchema} value={config} onChange={setConfig} />
          </>
        )}

        {status.kind === "error" && <div style={{ color: "var(--danger)" }}>{status.message}</div>}
        {status.kind === "ok" && <div style={{ color: "var(--ok)" }}>{status.message ?? "Connection OK"}</div>}

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
