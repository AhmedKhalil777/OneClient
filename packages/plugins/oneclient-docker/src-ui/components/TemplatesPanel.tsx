import { useEffect, useState } from "react";
import { Icon } from "@oneclient/editor-kit/react";
import { type TemplateItem, listTemplates, runTemplate } from "../api.js";

type Status = { kind: "running" } | { kind: "done"; message: string } | { kind: "error"; message: string };

/**
 * Infrastructure for testing: every container template the installed plugins contribute, each with a small form
 * (container name, host ports, credentials, connection name). "Run & connect" pulls the image, starts the container,
 * waits until the plugin can connect and saves that connection — progress shows in the Tasks panel.
 */
export function TemplatesPanel({ focus, onChanged }: { focus: string | null; onChanged: () => void }) {
  const [templates, setTemplates] = useState<TemplateItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    listTemplates()
      .then(setTemplates)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!templates) return <div className="empty-state">Loading templates…</div>;
  if (templates.length === 0) {
    return (
      <div className="empty-state">
        No templates. Plugins add theirs under <code>contributes.extensions["docker.containerTemplates"]</code> — install or enable PostgreSQL, SQL Server, Redis, Kafka, Azure Blob Storage or
        Keycloak.
      </div>
    );
  }

  const focused = !showAll && focus ? templates.filter((t) => t.key === focus) : [];
  const shown = focused.length ? focused : templates;
  return (
    <>
      <p className="panel-intro">
        Start a container for any installed plugin and get a ready connection to it — handy for local development and tests. Progress shows in the <strong>Tasks</strong> panel.
        {focused.length > 0 && (
          <>
            {" "}
            <button className="link-btn" onClick={() => setShowAll(true)}>
              Show all {templates.length} templates
            </button>
          </>
        )}
      </p>
      <div className="template-grid">
        {shown.map((t) => (
          <TemplateCard key={t.key} template={t} onChanged={onChanged} />
        ))}
      </div>
    </>
  );
}

function TemplateCard({ template: t, onChanged }: { template: TemplateItem; onChanged: () => void }) {
  const [name, setName] = useState(t.name);
  const [ports, setPorts] = useState<Record<string, number>>(Object.fromEntries(t.ports.map((p) => [p.container, p.host])));
  const [variables, setVariables] = useState<Record<string, string>>(Object.fromEntries(t.variables.map((v) => [v.name, v.value])));
  const [connectionName, setConnectionName] = useState(t.connectionName);
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  async function run() {
    setStatus({ kind: "running" });
    try {
      const result = await runTemplate({ template: t.key, name, ports, variables, connectionName });
      setStatus(result.ok ? { kind: "done", message: result.message ?? "Ready." } : { kind: "error", message: result.error ?? "Failed." });
      onChanged();
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const busy = status?.kind === "running";
  return (
    <div className="template-card">
      <div className="template-head">
        {t.icon.startsWith("$(") ? <Icon id={t.icon.slice(2, -1)} size={28} /> : <span className="template-icon-fallback">🐳</span>}
        <div className="template-titles">
          <div className="card-title">{t.title}</div>
          <div className="card-sub mono">{t.image}</div>
        </div>
      </div>
      {t.description && <p className="template-desc">{t.description}</p>}
      {t.existing.length > 0 && (
        <p className="template-existing">
          Already here: {t.existing.map((c) => `${c.name} (${c.state})`).join(", ")}
        </p>
      )}

      <div className="form-grid">
        <label>
          Container name
          <input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </label>
        {t.ports.map((p) => (
          <label key={p.container}>
            {p.label} port <span className="dim">(host → {p.container})</span>
            <input
              type="number"
              min={1}
              max={65535}
              value={ports[p.container] ?? ""}
              disabled={busy}
              onChange={(e) => setPorts({ ...ports, [p.container]: Number(e.target.value) })}
            />
          </label>
        ))}
        {t.variables.map((v) => (
          <label key={v.name} title={v.description}>
            {v.label}
            <span className="input-with-toggle">
              <input
                type={v.secret && !reveal ? "password" : "text"}
                value={variables[v.name] ?? ""}
                disabled={busy}
                onChange={(e) => setVariables({ ...variables, [v.name]: e.target.value })}
                spellCheck={false}
              />
              {v.secret && (
                <button type="button" className="icon-btn" onClick={() => setReveal(!reveal)}>
                  {reveal ? "Hide" : "Show"}
                </button>
              )}
            </span>
          </label>
        ))}
        <label>
          {t.product} connection name
          <input value={connectionName} disabled={busy} onChange={(e) => setConnectionName(e.target.value)} />
        </label>
      </div>

      <div className="template-actions">
        <button className="primary-btn" disabled={busy || !name.trim()} onClick={() => void run()}>
          {busy ? "Starting… (see Tasks)" : "Run & connect"}
        </button>
        {status?.kind === "done" && <span className="status-ok">✓ {status.message}</span>}
      </div>
      {status?.kind === "error" && <div className="error-banner pre">{status.message}</div>}
    </div>
  );
}
