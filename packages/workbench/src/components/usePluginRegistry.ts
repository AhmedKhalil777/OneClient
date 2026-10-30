import { useCallback, useEffect, useState } from "react";
import type { AvailablePlugin, PluginRegistryInfo, PluginSummary } from "@oneclient/backend/shared/types.js";

/** True when `a` is a newer x.y.z than `b` (pre-release tags are ignored — the registry only has releases). */
export function isNewer(a: string, b: string): boolean {
  const parts = (v: string) => v.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']*': (Error: )?/, "");

/** Plugins released on GitHub (listed in plugin.json) and what can be done with them: install, update, uninstall, and the optional GitHub token. */
export function usePluginRegistry() {
  const [registry, setRegistry] = useState<PluginRegistryInfo | null>(null);
  const [available, setAvailable] = useState<AvailablePlugin[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<Record<string, "installing" | "uninstalling">>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAvailable(await window.oneclient.listAvailablePlugins());
    } catch (err) {
      setError(message(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void window.oneclient.pluginRegistryInfo().then(setRegistry);
    void refresh();
  }, [refresh]);

  /** Saves the optional GitHub token (an empty one forgets it) and loads the list again. */
  const saveToken = useCallback(
    async (token: string) => {
      try {
        await window.oneclient.setPluginRegistryToken(token);
        const info = await window.oneclient.pluginRegistryInfo();
        setRegistry(info);
        await refresh();
        return true;
      } catch (err) {
        setError(message(err));
        return false;
      }
    },
    [refresh],
  );

  async function run(id: string, kind: "installing" | "uninstalling", job: () => Promise<unknown>) {
    setBusy((b) => ({ ...b, [id]: kind }));
    setError(null);
    try {
      await job();
    } catch (err) {
      setError(`${kind === "installing" ? "Install" : "Uninstall"} of ${id} failed: ${message(err)}`);
    } finally {
      setBusy(({ [id]: _done, ...rest }) => rest);
    }
  }
  const install = (id: string, version?: string) => run(id, "installing", () => window.oneclient.installPlugin(id, version));
  const uninstall = (p: PluginSummary) => {
    if (window.confirm(`Uninstall ${p.displayName ?? p.id}? Its connections stay saved and work again if you reinstall it.`)) void run(p.id, "uninstalling", () => window.oneclient.uninstallPlugin(p.id));
  };

  return { registry, available, loading, busy, error, refresh, saveToken, install, uninstall };
}
