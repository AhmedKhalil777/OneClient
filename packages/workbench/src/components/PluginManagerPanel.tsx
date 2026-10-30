import { useMemo, useState } from "react";
import type { PluginSummary } from "@oneclient/backend/shared/types.js";
import { AssetIcon } from "./AssetIcon.js";
import { isNewer, usePluginRegistry } from "./usePluginRegistry.js";

/**
 * The Plugins tab: one card per installed plugin with what it can do, grouped by category (its manifest `features`),
 * so you can tell at a glance whether it is worth trying; search looks through the features too. Above them, plugins
 * released on GitHub can be installed, updated and uninstalled without restarting.
 */
export function PluginManagerPanel({ plugins, hasConnections, onTry, onOpenPlugin }: { plugins: PluginSummary[]; hasConnections: (pluginId: string) => boolean; onTry: (pluginId: string) => void; onOpenPlugin: (pluginId: string, title?: string) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const { registry, available, loading, busy, error, refresh, saveToken, install, uninstall } = usePluginRegistry();
  const [token, setToken] = useState("");
  const [editingToken, setEditingToken] = useState(false);
  async function submitToken() {
    if (await saveToken(token)) {
      setToken("");
      setEditingToken(false);
    }
  }

  const installedById = useMemo(() => new Map(plugins.map((p) => [p.id, p])), [plugins]);
  const latestById = useMemo(() => new Map((available ?? []).map((a) => [a.id, a])), [available]);
  const notInstalled = (available ?? []).filter((a) => !installedById.has(a.id) && (!q || `${a.id} ${a.description ?? ""}`.toLowerCase().includes(q)));

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

      <section className="pm-registry">
        <div className="pm-registry-head">
          <strong>Get more plugins</strong>
          <span className="pm-id">{registry ? `${registry.scope} · releases for oneClient ${registry.appVersion}` : ""}</span>
          <span className="pm-spacer" />
          {!editingToken && (
            <>
              <button className="btn" disabled={loading} onClick={() => void refresh()}>
                {loading ? "Checking…" : "Refresh"}
              </button>
              <button className="btn" onClick={() => setEditingToken(true)}>
                {registry?.hasToken ? "Change GitHub token" : "GitHub token…"}
              </button>
            </>
          )}
        </div>

        {registry && editingToken && (
          <div className="pm-token">
            <p className="pm-sub">No token is needed to install plugins. Add a GitHub token only if the repository is private or GitHub rate-limits you. It is stored encrypted on this machine.</p>
            <div className="pm-token-row">
              <input className="pm-search" type="password" placeholder="ghp_…" value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} autoComplete="off" />
              <button className="btn btn-primary" disabled={!token.trim() && !registry.hasToken} onClick={() => void submitToken()}>
                {token.trim() ? "Save token" : "Remove token"}
              </button>
              {editingToken && (
                <button className="btn" onClick={() => { setEditingToken(false); setToken(""); }}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        {error && <p className="pm-error">{error}</p>}
        {available && notInstalled.length === 0 && !error && <p className="pm-sub">{q ? `No uninstalled plugin matches “${query}”.` : available.length === 0 ? `No plugin has a release for oneClient ${registry?.appVersion ?? ""} yet.` : "Every released plugin is installed."}</p>}

        {notInstalled.length > 0 && (
          <div className="pm-grid">
            {notInstalled.map((a) => (
              <article key={a.id} className="pm-card">
                <header className="pm-card-head">
                  <div className="pm-title pm-link" onClick={() => onOpenPlugin(a.id)} title="Open the plugin page">
                    <strong>{a.id}</strong>
                    <span className="pm-id">v{a.latest}</span>
                  </div>
                  <button className="btn btn-primary" disabled={Boolean(busy[a.id])} onClick={() => void install(a.id)}>
                    {busy[a.id] ? "Installing…" : "Install"}
                  </button>
                </header>
                {a.description && <p className="pm-desc">{a.description}</p>}
              </article>
            ))}
          </div>
        )}
      </section>

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
                <div className="pm-title pm-link" onClick={() => onOpenPlugin(p.id, p.displayName)} title="Open the plugin page">
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
                  <button className="btn" disabled={Boolean(busy[p.id])} onClick={() => void toggle(p.id, p.state === "disabled")}>
                    {p.state === "disabled" ? "Enable" : "Disable"}
                  </button>
                )}
                {p.removable && latestById.get(p.id) && isNewer(latestById.get(p.id)!.latest, p.version) && (
                  <button className="btn btn-primary" disabled={Boolean(busy[p.id])} onClick={() => void install(p.id)}>
                    {busy[p.id] === "installing" ? "Updating…" : `Update to v${latestById.get(p.id)!.latest}`}
                  </button>
                )}
                {p.removable && (
                  <button className="btn btn-danger" disabled={Boolean(busy[p.id])} onClick={() => uninstall(p)}>
                    {busy[p.id] === "uninstalling" ? "Uninstalling…" : "Uninstall"}
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
