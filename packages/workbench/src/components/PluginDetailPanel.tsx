import { useEffect, useState } from "react";
import type { PluginDetails, PluginSummary } from "@oneclient/backend/shared/types.js";
import { AssetIcon } from "./AssetIcon.js";
import { Markdown } from "./Markdown.js";
import { isNewer, usePluginRegistry } from "./usePluginRegistry.js";

type PageTab = "details" | "features" | "contributions";

/**
 * A plugin's own page (VS Code's extension editor): icon, name, version and publisher, the actions that apply
 * (install, update, enable / disable, uninstall), and tabs for the README, the features and what it contributes.
 * Works for a plugin that isn't installed too — its README then comes from the registry.
 */
export function PluginDetailPanel({ pluginId, plugins, hasConnections, onTry }: { pluginId: string; plugins: PluginSummary[]; hasConnections: boolean; onTry: () => void }) {
  const live = plugins.find((p) => p.id === pluginId);
  const [details, setDetails] = useState<PluginDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<PageTab>("details");
  const { busy, error, install, uninstall } = usePluginRegistry();

  // Reload when the plugin appears, goes, or changes version / state (an install, update, enable or disable).
  const key = live ? `${live.version}:${live.state}` : "absent";
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    window.oneclient.getPluginDetails(pluginId).then(
      (d) => !cancelled && setDetails(d),
      (err: unknown) => !cancelled && (setDetails(null), setLoadError((err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']*': (Error: )?/, ""))),
    );
    return () => {
      cancelled = true;
    };
  }, [pluginId, key]);

  if (!details) return <div className="pd"><p className="pm-sub">{loadError ? `Couldn't load ${pluginId}: ${loadError}` : "Loading…"}</p></div>;

  const working = busy[pluginId];
  const update = details.installed && details.removable && details.latestVersion && isNewer(details.latestVersion, details.version) ? details.latestVersion : undefined;
  const usable = details.installed && details.state !== "invalid" && details.state !== "incompatible";
  const contributionCount = (details.contributions ?? []).reduce((n, c) => n + c.items.length, 0);
  const featureCount = (details.features ?? []).reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="pd">
      <header className="pd-head">
        {details.installed ? <AssetIcon pluginId={pluginId} {...(details.icon ? { icon: details.icon } : {})} size={72} /> : <div className="pd-noicon">{(details.displayName ?? pluginId).replace(/^oneclient-/, "").slice(0, 2).toUpperCase()}</div>}
        <div className="pd-title">
          <h1>
            {details.displayName ?? pluginId}
            {details.installed && details.state && <span className={`badge badge-${details.state}`}>{details.state}</span>}
          </h1>
          <div className="pd-meta">
            {details.publisher && <span>{details.publisher}</span>}
            {details.version && <span>v{details.version}</span>}
            {details.license && <span>{details.license}</span>}
            {details.repository && /^https?:/i.test(details.repository) && <a href={details.repository} target="_blank" rel="noreferrer noopener">Repository</a>}
            <span className="pm-id">{pluginId}</span>
          </div>
          {details.description && <p className="pd-desc">{details.description}</p>}
          <div className="pd-actions">
            {!details.installed && (
              <button className="btn btn-primary" disabled={Boolean(working)} onClick={() => void install(pluginId)}>
                {working === "installing" ? "Installing…" : "Install"}
              </button>
            )}
            {details.installed && details.state === "active" && hasConnections && (
              <button className="btn btn-primary" onClick={onTry}>
                Try it
              </button>
            )}
            {update && (
              <button className="btn btn-primary" disabled={Boolean(working)} onClick={() => void install(pluginId)}>
                {working === "installing" ? "Updating…" : `Update to v${update}`}
              </button>
            )}
            {usable && (
              <button className="btn" disabled={Boolean(working)} onClick={() => void window.oneclient.setPluginEnabled(pluginId, details.state === "disabled")}>
                {details.state === "disabled" ? "Enable" : "Disable"}
              </button>
            )}
            {live?.removable && (
              <button
                className="btn btn-danger"
                disabled={Boolean(working)}
                onClick={() => window.confirm(`Uninstall ${details.displayName ?? pluginId}? Its connections stay saved and work again if you reinstall it.`) && uninstall(live)}
              >
                {working === "uninstalling" ? "Uninstalling…" : "Uninstall"}
              </button>
            )}
          </div>
          {details.installed && !details.removable && <p className="pd-note">Bundled with oneClient — it can be disabled but not uninstalled.</p>}
          {details.error && <p className="pm-error">{details.error}</p>}
          {error && <p className="pm-error">{error}</p>}
          {details.registryError && <p className="pd-note">Registry: {details.registryError}</p>}
        </div>
      </header>

      <nav className="pd-tabs" role="tablist">
        {([
          ["details", "Details", undefined],
          ["features", "Features", featureCount],
          ["contributions", "Contributions", contributionCount],
        ] as const).map(([id, label, count]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : undefined} onClick={() => setTab(id)}>
            {label}
            {count ? <em>{count}</em> : null}
          </button>
        ))}
      </nav>

      <div className="pd-body">
        <main>
          {tab === "details" && (
            <>
              {details.readmeUrl && (
                <p className="pd-note">
                  Shown from <a href={details.readmeUrl} target="_blank" rel="noreferrer noopener">README.md on GitHub</a>.
                </p>
              )}
              {details.readmeSource && details.readmeSource !== "github" && <p className="pd-note">GitHub couldn't be reached, so this is the {details.readmeSource === "installed" ? "installed" : "published"} README.</p>}
              {details.readme ? <Markdown source={details.readme} baseUrl={details.readmeUrl} /> : <p className="pm-sub">{details.description ?? "This plugin has no README."}</p>}
            </>
          )}

          {tab === "features" &&
            ((details.features ?? []).length === 0 ? (
              <p className="pm-sub">This plugin doesn't list its features.</p>
            ) : (
              details.features!.map((g) => (
                <section key={g.category} className="pm-group">
                  <h4>{g.category}</h4>
                  <ul>
                    {g.items.map((i) => (
                      <li key={i.title}>
                        {i.title}
                        {i.description && <span className="pm-item-desc"> — {i.description}</span>}
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            ))}

          {tab === "contributions" &&
            ((details.contributions ?? []).length === 0 ? (
              <p className="pm-sub">{details.installed ? "This plugin adds nothing declaratively." : "Install the plugin to see what it adds."}</p>
            ) : (
              details.contributions!.map((c) => (
                <section key={c.kind} className="pd-contrib">
                  <h3>
                    {c.kind} <em>{c.items.length}</em>
                  </h3>
                  <table>
                    <tbody>
                      {c.items.map((it) => (
                        <tr key={it.id}>
                          <td>{it.title ?? it.id}</td>
                          <td className="pm-id">{it.title ? it.id : ""}</td>
                          <td className="pm-item-desc">{it.description ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))
            ))}
        </main>

        <aside className="pd-side">
          <h4>Details</h4>
          <dl>
            <dt>Identifier</dt>
            <dd>{pluginId}</dd>
            {details.version && (
              <>
                <dt>Version</dt>
                <dd>{details.version}</dd>
              </>
            )}
            {details.latestVersion && details.latestVersion !== details.version && (
              <>
                <dt>Latest</dt>
                <dd>{details.latestVersion}</dd>
              </>
            )}
            {details.publisher && (
              <>
                <dt>Publisher</dt>
                <dd>{details.publisher}</dd>
              </>
            )}
            {details.engine && (
              <>
                <dt>Works with oneClient</dt>
                <dd>{details.engine}</dd>
              </>
            )}
            {details.license && (
              <>
                <dt>License</dt>
                <dd>{details.license}</dd>
              </>
            )}
          </dl>
        </aside>
      </div>
    </div>
  );
}
