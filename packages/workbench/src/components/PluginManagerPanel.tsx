import { useMemo, useState } from "react";
import type { PluginSummary } from "@oneclient/backend/shared/types.js";
import { AssetIcon } from "./AssetIcon.js";

/**
 * The Plugins tab: one card per installed plugin with what it can do, grouped by category (its manifest `features`),
 * so you can tell at a glance whether it is worth trying; search looks through the features too.
 */
export function PluginManagerPanel({ plugins, hasConnections, onTry }: { plugins: PluginSummary[]; hasConnections: (pluginId: string) => boolean; onTry: (pluginId: string) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const shown = useMemo(
    () =>
      plugins.filter((p) => {
        if (!q) return true;
        const hay = [p.displayName, p.id, p.description, ...(p.features ?? []).flatMap((g) => [g.category, ...g.items.flatMap((i) => [i.title, i.description ?? ""])])].join(" ").toLowerCase();
        return hay.includes(q);
      }),
    [plugins, q],
  );
  const active = plugins.filter((p) => p.state === "active").length;

  async function toggle(id: string, enabled: boolean) {
    await window.oneclient.setPluginEnabled(id, enabled);
  }

  return (
    <div className="pm">
      <div className="pm-head">
        <div>
          <h2>Plugins</h2>
          <p className="pm-sub">
            {plugins.length} installed · {active} active. Every integration is a plugin — enable or disable any of them live. The Explorer, Search, editor, Git and Terminal are part of oneClient itself.
          </p>
        </div>
        <input className="pm-search" placeholder="Search plugins and features — e.g. “execution plan”, “kafka”, “mermaid”" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
      </div>

      {shown.length === 0 && <p className="pm-sub">No plugin matches “{query}”.</p>}

      <div className="pm-grid">
        {shown.map((p) => {
          const groups = p.features ?? [];
          const total = groups.reduce((n, g) => n + g.items.length, 0);
          const usable = p.state !== "invalid" && p.state !== "incompatible";
          return (
            <article key={p.id} className={`pm-card ${p.state === "disabled" ? "off" : ""}`}>
              <header className="pm-card-head">
                <AssetIcon pluginId={p.id} {...(p.icon ? { icon: p.icon } : {})} size={28} />
                <div className="pm-title">
                  <strong>{p.displayName ?? p.id}</strong>
                  <span className="pm-id">
                    {p.id} · v{p.version}
                  </span>
                </div>
                <span className={`badge badge-${p.state}`}>{p.state}</span>
              </header>

              {p.description && <p className="pm-desc">{p.description}</p>}
              {p.error && <p className="pm-error">{p.error}</p>}

              {groups.length > 0 && (
                <div className="pm-cats" aria-label="Feature categories">
                  {groups.map((g) => (
                    <span key={g.category} className="pm-cat" title={g.items.map((i) => i.title).join("\n")}>
                      {g.category} <em>{g.items.length}</em>
                    </span>
                  ))}
                </div>
              )}

              {groups.length > 0 && (
                <details className="pm-features" open={Boolean(q)}>
                  <summary>What it can do ({total})</summary>
                  {groups.map((g) => (
                    <section key={g.category} className="pm-group">
                      <h4>{g.category}</h4>
                      <ul>
                        {g.items.map((i) => (
                          <li key={i.title} className={q && `${i.title} ${i.description ?? ""}`.toLowerCase().includes(q) ? "hit" : undefined}>
                            {i.title}
                            {i.description && <span className="pm-item-desc"> — {i.description}</span>}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </details>
              )}

              <footer className="pm-actions">
                {p.state === "active" && hasConnections(p.id) && (
                  <button className="btn btn-primary" onClick={() => onTry(p.id)} title="Add a connection and try it">
                    Try it
                  </button>
                )}
                {usable && (
                  <button className="btn" onClick={() => void toggle(p.id, p.state === "disabled")}>
                    {p.state === "disabled" ? "Enable" : "Disable"}
                  </button>
                )}
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}
