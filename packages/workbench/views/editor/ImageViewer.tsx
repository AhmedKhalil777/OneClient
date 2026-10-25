import { useEffect, useRef, useState } from "react";
import { fileName, filePath, readImage } from "./api.js";

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; dataUrl: string; mime: string; size: number };
type Backdrop = "checker" | "dark" | "light";
const BACKDROPS: Backdrop[] = ["checker", "dark", "light"];
const STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

const formatSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

/** Read-only viewer for raster images: fit / actual size / zoom, drag to pan, and a backdrop for transparency. */
export function ImageViewer() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [natural, setNatural] = useState<{ w: number; h: number } | undefined>();
  /** "fit" shrinks big images to the window; a number is an exact scale. */
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [backdrop, setBackdrop] = useState<Backdrop>("checker");
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    readImage()
      .then((r) => live && setState(r.ok ? { kind: "ready", dataUrl: r.dataUrl, mime: r.mime, size: r.size } : { kind: "error", message: r.error }))
      .catch((err: unknown) => live && setState({ kind: "error", message: String(err) }));
    return () => {
      live = false;
    };
  }, []);

  const fitScale = (): number => {
    const el = stage.current;
    if (!el || !natural) return 1;
    return Math.min(1, (el.clientWidth - 32) / natural.w, (el.clientHeight - 32) / natural.h);
  };
  const scale = zoom === "fit" ? fitScale() : zoom;

  const step = (dir: 1 | -1) => {
    const cur = scale;
    const next = dir > 0 ? STEPS.find((s) => s > cur + 1e-6) : [...STEPS].reverse().find((s) => s < cur - 1e-6);
    if (next) setZoom(next);
  };

  // Ctrl+wheel zooms; dragging pans.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      step(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = stage.current;
    if (!el || e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    let x = e.clientX;
    let y = e.clientY;
    el.classList.add("panning");
    const move = (ev: PointerEvent) => {
      el.scrollLeft -= ev.clientX - x;
      el.scrollTop -= ev.clientY - y;
      x = ev.clientX;
      y = ev.clientY;
    };
    const end = () => {
      el.classList.remove("panning");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  if (state.kind === "loading") return <div className="message">Loading {filePath}…</div>;
  if (state.kind === "error") return <div className="message error">{state.message}</div>;

  const percent = Math.round(scale * 100);
  return (
    <div className="img-viewer">
      <div className="img-toolbar">
        <span className="img-name" title={filePath}>{fileName}</span>
        <span className="img-spacer" />
        <button className="img-btn" title="Zoom out (Ctrl+wheel)" onClick={() => step(-1)}>−</button>
        <span className="img-zoom" title="Current zoom">{percent}%</span>
        <button className="img-btn" title="Zoom in (Ctrl+wheel)" onClick={() => step(1)}>+</button>
        <button className={`img-btn ${zoom === "fit" ? "on" : ""}`} title="Fit to window" onClick={() => setZoom("fit")}>Fit</button>
        <button className={`img-btn ${zoom === 1 ? "on" : ""}`} title="Actual size (100%)" onClick={() => setZoom(1)}>1:1</button>
        <button className="img-btn" title={`Background: ${backdrop} — click to change`} onClick={() => setBackdrop(BACKDROPS[(BACKDROPS.indexOf(backdrop) + 1) % BACKDROPS.length]!)}>
          <span className={`img-swatch ${backdrop}`} />
        </button>
      </div>
      <div ref={stage} className={`img-stage ${backdrop}`} onPointerDown={onPointerDown} onDoubleClick={() => setZoom(zoom === "fit" ? 1 : "fit")}>
        <div className="img-center">
          <img
            src={state.dataUrl}
            alt={fileName}
            draggable={false}
            className={scale >= 2 ? "pixelated" : ""}
            style={natural ? { width: natural.w * scale, height: natural.h * scale } : undefined}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
        </div>
      </div>
      <div className="img-status">
        <span>{natural ? `${natural.w} × ${natural.h}` : "…"}</span>
        <span>{formatSize(state.size)}</span>
        <span>{state.mime.replace("image/", "").toUpperCase()}</span>
      </div>
    </div>
  );
}
