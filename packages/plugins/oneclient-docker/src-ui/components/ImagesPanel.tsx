import { useState } from "react";
import { type ImageRow, pullImage } from "../api.js";
import { ImagePicker } from "./ImagePicker.js";

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

export function ImagesPanel({ images, onChanged }: { images: ImageRow[]; onChanged: () => void }) {
  const [pullTag, setPullTag] = useState("");
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doPull() {
    if (!pullTag.trim()) return;
    setPulling(true);
    setError(null);
    try {
      const result = await pullImage(pullTag.trim());
      if (!result.ok) setError(result.error ?? "Pull failed.");
      else {
        setPullTag("");
        onChanged();
      }
    } finally {
      setPulling(false);
    }
  }

  return (
    <>
      <div className="pull-row">
        <ImagePicker value={pullTag} onChange={setPullTag} disabled={pulling} placeholder="Search Docker Hub or type an image to pull, e.g. nginx:latest" />
        <button className="icon-btn" disabled={pulling || !pullTag.trim()} onClick={() => void doPull()}>
          {pulling ? "Pulling…" : "Pull"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {images.length === 0 ? (
        <div className="empty-state">No images yet. Pull one above.</div>
      ) : (
        <div className="card-grid">
          {images.map((img) => (
            <div className="card" key={img.id}>
              <div className="card-main">
                <div className="card-title">{img.tag}</div>
                <div className="card-sub">
                  {formatSize(img.size)} — created {formatDate(img.created)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
