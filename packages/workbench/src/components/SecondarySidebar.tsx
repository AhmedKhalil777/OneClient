import { useEffect, useState } from "react";
import { ThemeIcon } from "../theme.js";
import { AssetIcon } from "./AssetIcon.js";
import { Tier2ViewHost } from "./Tier2ViewHost.js";

/** A plugin view shown in the secondary side bar (on the right, like VS Code's chat). */
export interface SecondaryView {
  title: string;
  pluginId: string;
  viewId: string;
  connectionId?: string;
  params?: Record<string, string>;
  icon?: string;
  /** The editor tab it came from, so "Move to Editor" puts it back as the same tab. */
  originId?: string;
}

const KEY = "oneclient.secondarySidebar";
export const SECONDARY_MIN = 280;
export const SECONDARY_MAX = 900;
const SECONDARY_DEFAULT = 400;

interface Stored {
  open: boolean;
  width: number;
  view: SecondaryView | null;
}

function load(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Stored> | null;
    const width = Number(raw?.width);
    return {
      open: raw?.open === true,
      width: width >= SECONDARY_MIN && width <= SECONDARY_MAX ? width : SECONDARY_DEFAULT,
      view: raw?.view && typeof raw.view.viewId === "string" && typeof raw.view.pluginId === "string" ? raw.view : null,
    };
  } catch {
    return { open: false, width: SECONDARY_DEFAULT, view: null };
  }
}

export const instanceIdOf = (v: SecondaryView) => `secondary:${v.pluginId}:${v.viewId}:${v.connectionId ?? ""}:${JSON.stringify(v.params ?? {})}`;

/** State of the secondary side bar: whether it is open, how wide, and which view it holds. Remembered across restarts. */
export function useSecondarySidebar() {
  const [state, setState] = useState<Stored>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable: the layout just isn't remembered */
    }
  }, [state]);

  return {
    open: state.open,
    width: state.width,
    view: state.view,
    toggle: () => setState((s) => ({ ...s, open: !s.open })),
    hide: () => setState((s) => ({ ...s, open: false })),
    /** Show a view here (replacing the current one) and open the bar. */
    show: (view: SecondaryView) => setState((s) => ({ ...s, open: true, view })),
    clearView: () => setState((s) => ({ ...s, view: null })),
    setWidth: (width: number) => setState((s) => ({ ...s, width })),
  };
}

export type SecondarySidebarState = ReturnType<typeof useSecondarySidebar>;

/** Drag the left edge: the width is written straight to the element (one layout per frame); React learns it at the end. */
function startResizing(e: React.PointerEvent<HTMLElement>, state: SecondarySidebarState) {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  const bar = handle.parentElement as HTMLElement;
  const right = bar.getBoundingClientRect().right;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("sidebar-resizing");
  let latest = state.width;
  let frame = 0;
  const apply = () => {
    frame = 0;
    bar.style.width = `${latest}px`;
  };
  const onMove = (ev: PointerEvent) => {
    latest = Math.min(SECONDARY_MAX, Math.max(SECONDARY_MIN, right - ev.clientX));
    if (!frame) frame = requestAnimationFrame(apply);
  };
  const onEnd = () => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onEnd);
    handle.removeEventListener("pointercancel", onEnd);
    if (frame) cancelAnimationFrame(frame);
    document.body.classList.remove("sidebar-resizing");
    state.setWidth(latest);
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onEnd);
  handle.addEventListener("pointercancel", onEnd);
}

export function SecondarySidebar({ state, overlayOpen, onMoveToEditor }: { state: SecondarySidebarState; overlayOpen: boolean; onMoveToEditor: (view: SecondaryView) => void }) {
  if (!state.open) return null;
  const view = state.view;
  return (
    <aside className="secondary-sidebar" data-ctx="secondary" style={{ width: state.width }} aria-label="Secondary Side Bar">
      <div className="secondary-resize" onPointerDown={(e) => startResizing(e, state)} title="Drag to resize" />
      <div className="secondary-head">
        {view?.icon && <AssetIcon pluginId={view.pluginId} icon={view.icon} size={14} />}
        <span className="secondary-title" title={view?.title}>{view?.title ?? "Secondary Side Bar"}</span>
        {view && (
          <button className="icon-button" title="Move to Editor" aria-label="Move to Editor" onClick={() => onMoveToEditor(view)}>
            <ThemeIcon id="split-right" size={15} />
          </button>
        )}
        <button className="icon-button" title="Close Secondary Side Bar (Ctrl+Alt+B)" aria-label="Close Secondary Side Bar" onClick={state.hide}>
          <ThemeIcon id="close" size={15} />
        </button>
      </div>
      <div className="secondary-body">
        {view ? (
          <Tier2ViewHost key={instanceIdOf(view)} instanceId={instanceIdOf(view)} pluginId={view.pluginId} viewId={view.viewId} connectionId={view.connectionId} params={view.params} active={!overlayOpen} />
        ) : (
          <div className="secondary-empty">
            <p>Keep a chat or any view next to your editors.</p>
            <p>Right-click a conversation in the sidebar and choose <b>Open in Secondary Side Bar</b>, or right-click an editor tab and choose <b>Move to Secondary Side Bar</b>.</p>
          </div>
        )}
      </div>
    </aside>
  );
}
