import { useCallback, useEffect, useMemo, useState } from "react";
import type { ViewContribution } from "@oneclient/plugin-api";
import { ThemeIcon } from "../theme.js";
import { AssetIcon } from "./AssetIcon.js";
import { OutputView } from "./OutputView.js";
import { TasksView } from "./TasksView.js";
import { Tier2ViewHost } from "./Tier2ViewHost.js";

export type PanelView = ViewContribution & { pluginId: string };

/** The shell's own panel tab (no plugin behind it): the app-wide Output log. */
export const OUTPUT_VIEW: PanelView = { pluginId: "core", id: "output", title: "Output", tier: 2, location: "panel", icon: "$(output)" };
export const OUTPUT_PANEL_KEY = "core:output";
/** Background tasks (Git, Task Runner, plugins) — the shell's own panel tab too. */
export const TASKS_VIEW: PanelView = { pluginId: "core", id: "tasks", title: "Tasks", tier: 2, location: "panel", icon: "$(play)" };
export const TASKS_PANEL_KEY = "core:tasks";

const HEIGHT_KEY = "oneclient.panelHeight";
const OPEN_KEY = "oneclient.panelOpen";
const ACTIVE_KEY = "oneclient.panelActive";
const MIN_HEIGHT = 120;

const keyOf = (v: PanelView) => `${v.pluginId}:${v.id}`;
const instanceOf = (key: string) => `panel:${key}`;

function readNumber(key: string, fallback: number): number {
  const n = Number(localStorage.getItem(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * State for the VS Code-style bottom panel that hosts every Tier 2 view
 * contributed with `location: "panel"` (e.g. the Terminal). Views are
 * mounted the first time they're shown and then kept alive while hidden,
 * so a terminal keeps running when the panel is closed.
 */
export function usePanel(views: PanelView[]) {
  const [open, setOpenState] = useState(() => localStorage.getItem(OPEN_KEY) === "1");
  const [active, setActive] = useState<string | null>(() => localStorage.getItem(ACTIVE_KEY));
  const [height, setHeightState] = useState(() => readNumber(HEIGHT_KEY, 260));
  const [mounted, setMounted] = useState<Set<string>>(() => new Set());

  const activeKey = views.some((v) => keyOf(v) === active) ? active : views[0] ? keyOf(views[0]) : null;

  // Mount what's visible; once mounted, stay mounted.
  useEffect(() => {
    if (open && activeKey && !mounted.has(activeKey)) setMounted((m) => new Set(m).add(activeKey));
  }, [open, activeKey, mounted]);

  useEffect(() => localStorage.setItem(OPEN_KEY, open ? "1" : "0"), [open]);
  useEffect(() => localStorage.setItem(HEIGHT_KEY, String(height)), [height]);
  useEffect(() => {
    if (activeKey) localStorage.setItem(ACTIVE_KEY, activeKey);
  }, [activeKey]);

  const focusActive = useCallback((key: string | null) => {
    // Give the view a moment to open/receive bounds before focusing it.
    if (key && key !== OUTPUT_PANEL_KEY) setTimeout(() => void window.oneclient.focusView(instanceOf(key)), 60);
  }, []);

  const show = useCallback(
    (key: string, opts: { focus?: boolean } = {}) => {
      setActive(key);
      setOpenState(true);
      // Revealed by a view (e.g. results after F5): keep focus where the user is typing.
      if (opts.focus !== false) focusActive(key);
    },
    [focusActive],
  );

  const toggle = useCallback(() => {
    setOpenState((wasOpen) => {
      if (!wasOpen) focusActive(activeKey);
      return !wasOpen;
    });
  }, [activeKey, focusActive]);

  return {
    views,
    open,
    activeKey,
    height,
    mounted,
    setOpen: setOpenState,
    setActive,
    setHeight: (h: number) => setHeightState(Math.max(MIN_HEIGHT, Math.round(h))),
    show,
    toggle,
    /** Find a panel view by its contribution id (e.g. "terminal.panel"). */
    keyForViewId: (viewId: string) => {
      const v = views.find((x) => x.id === viewId);
      return v ? keyOf(v) : null;
    },
  };
}

export type PanelState = ReturnType<typeof usePanel>;

export function Panel({ state, overlayOpen, onRunTask }: { state: PanelState; overlayOpen: boolean; onRunTask: () => void }) {
  const { views, open, activeKey, height, mounted } = state;
  const byKey = useMemo(() => new Map(views.map((v) => [keyOf(v), v])), [views]);

  function startResize(e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const panel = handle.parentElement as HTMLElement;
    // Pointer capture: the handle keeps getting the moves when the pointer crosses a view's iframe or leaves the window.
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startHeight = height;
    const maxHeight = window.innerHeight - 160;
    let latest = startHeight;
    let frame = 0;
    // The panel's height is written straight to the element, at most once per frame; React learns the final height at the end.
    const apply = () => {
      frame = 0;
      panel.style.height = `${latest}px`;
    };
    const onMove = (ev: PointerEvent) => {
      latest = Math.max(MIN_HEIGHT, Math.min(maxHeight, startHeight + startY - ev.clientY));
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      if (frame) cancelAnimationFrame(frame);
      document.body.classList.remove("panel-resizing");
      state.setHeight(latest);
    };
    document.body.classList.add("panel-resizing");
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  if (views.length === 0) return null;

  return (
    <div className="panel" style={{ height: open ? height : 0 }} hidden={!open}>
      <div className="panel-resize-handle" onPointerDown={startResize} />
      <div className="panel-header">
        {/* Icon navigator: one button per plugin panel view; the active one's title is spelled out. */}
        <div className="panel-nav" role="tablist">
          {views.map((v) => {
            const key = keyOf(v);
            const isActive = key === activeKey;
            return (
              <button
                key={key}
                role="tab"
                aria-selected={isActive}
                className={`panel-nav-item ${isActive ? "active" : ""}`}
                title={v.title}
                onClick={() => state.show(key)}
              >
                <AssetIcon pluginId={v.pluginId} icon={v.icon} size={16} fallback={v.title.charAt(0)} />
              </button>
            );
          })}
        </div>
        <span className="panel-title">{activeKey ? byKey.get(activeKey)?.title.toUpperCase() : ""}</span>
        <span className="panel-spacer" />
        <button className="icon-button" title="Maximize panel" onClick={() => state.setHeight(window.innerHeight - 160)}>
          <ThemeIcon id="chevron-up" />
        </button>
        <button className="icon-button" title="Close panel (Ctrl+`)" onClick={() => state.setOpen(false)}>
          <ThemeIcon id="close" />
        </button>
      </div>
      <div className="panel-body">
        {[...mounted].map((key) => {
          const v = byKey.get(key);
          if (!v) return null;
          const visible = open && key === activeKey;
          if (v.pluginId === OUTPUT_VIEW.pluginId && v.id === OUTPUT_VIEW.id) {
            return (
              <div key={key} className="tier2-slot" hidden={!visible}>
                <OutputView visible={visible} />
              </div>
            );
          }
          if (v.pluginId === TASKS_VIEW.pluginId && v.id === TASKS_VIEW.id) {
            return (
              <div key={key} className="tier2-slot" hidden={!visible}>
                <TasksView visible={visible} onRunTask={onRunTask} />
              </div>
            );
          }
          return (
            <div key={key} className="tier2-slot" hidden={!visible}>
              <Tier2ViewHost instanceId={instanceOf(key)} pluginId={v.pluginId} viewId={v.id} active={visible && !overlayOpen} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
