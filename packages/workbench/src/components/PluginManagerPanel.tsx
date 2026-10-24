import type { PluginSummary } from "@oneclient/backend/shared/types.js";

export function PluginManagerPanel({ plugins }: { plugins: PluginSummary[] }) {
  async function toggle(id: string, enabled: boolean) {
    await window.oneclient.setPluginEnabled(id, enabled);
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Plugins</h2>
      <p style={{ color: "var(--text-dim)" }}>
        Installed plugins and their state. Install-from-file/registry lands in Phase 5 — for now this reflects
        whatever is in the app's plugins directory (in dev builds, <code>packages/plugins</code>). The Explorer, Search,
        editor and Terminal are part of oneClient itself, not plugins.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
            <th style={{ padding: "6px 8px" }}>Plugin</th>
            <th style={{ padding: "6px 8px" }}>Version</th>
            <th style={{ padding: "6px 8px" }}>State</th>
            <th style={{ padding: "6px 8px" }}></th>
          </tr>
        </thead>
        <tbody>
          {plugins.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <td style={{ padding: "6px 8px" }}>
                <div>{p.displayName ?? p.id}</div>
                <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{p.id}</div>
                {p.error && <div style={{ color: "var(--danger)", fontSize: 11 }}>{p.error}</div>}
              </td>
              <td style={{ padding: "6px 8px" }}>{p.version}</td>
              <td style={{ padding: "6px 8px" }}>
                <span className={`badge badge-${p.state}`}>{p.state}</span>
              </td>
              <td style={{ padding: "6px 8px" }}>
                {p.state !== "invalid" && p.state !== "incompatible" && (
                  <button className="btn" onClick={() => void toggle(p.id, p.state === "disabled")}>
                    {p.state === "disabled" ? "Enable" : "Disable"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
