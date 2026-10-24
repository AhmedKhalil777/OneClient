import { useEffect, useState } from "react";
import { type ContainerRow, type ImageRow, initialParams, listContainers, listImages } from "./api.js";
import { ContainersPanel } from "./components/ContainersPanel.js";
import { ImagesPanel } from "./components/ImagesPanel.js";
import { TemplatesPanel } from "./components/TemplatesPanel.js";

const POLL_MS = 3000;
type Tab = "containers" | "images" | "templates";

export function App() {
  const [tab, setTab] = useState<Tab>(initialParams.tab === "templates" || initialParams.tab === "images" ? initialParams.tab : "containers");
  const [containers, setContainers] = useState<ContainerRow[]>([]);
  const [images, setImages] = useState<ImageRow[]>([]);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [c, i] = await Promise.all([listContainers(), listImages()]);
      setContainers(c);
      setImages(i);
      setLastRefreshed(new Date());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  // After a container is started or a connection created: update this view and the sidebar trees.
  function changed() {
    void refresh();
    window.oneclientView.refreshExplorer();
  }

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(interval);
  }, []);

  const runningCount = containers.filter((c) => c.state === "running").length;

  return (
    <div className="app">
      <div className="toolbar">
        <h1>🐳 Docker</h1>
        <div className="tabs">
          <button className={`tab-btn ${tab === "containers" ? "active" : ""}`} onClick={() => setTab("containers")}>
            Containers ({containers.length})
          </button>
          <button className={`tab-btn ${tab === "images" ? "active" : ""}`} onClick={() => setTab("images")}>
            Images ({images.length})
          </button>
          <button className={`tab-btn ${tab === "templates" ? "active" : ""}`} onClick={() => setTab("templates")}>
            Templates
          </button>
        </div>
        <div className="toolbar-spacer" />
        <span className="refresh-indicator">
          {runningCount} running — {lastRefreshed ? `updated ${lastRefreshed.toLocaleTimeString()}` : "loading…"}
        </span>
      </div>

      <div className="content">
        {loadError && <div className="error-banner">{loadError}</div>}
        {tab === "containers" && <ContainersPanel containers={containers} onChanged={changed} onShowTemplates={() => setTab("templates")} />}
        {tab === "images" && <ImagesPanel images={images} onChanged={refresh} />}
        {tab === "templates" && <TemplatesPanel focus={initialParams.template} onChanged={changed} />}
      </div>
    </div>
  );
}
