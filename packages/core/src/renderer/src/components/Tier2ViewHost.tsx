import { useEffect, useRef } from "react";

/**
 * Hosts one Tier 2 view instance. The actual content lives in a native
 * `WebContentsView` layered over this div by the main process (see
 * ViewHostManager) — this component's only job is telling main where
 * that div currently is (via ResizeObserver) and when to open/close it.
 * Nothing is rendered inside this div itself.
 *
 * Stays mounted while its tab is in the background (`active === false`) so
 * the view keeps its state (e.g. unsaved edits); it's just shrunk to zero
 * size until its tab is selected again.
 */
export function Tier2ViewHost({
  instanceId,
  pluginId,
  viewId,
  connectionId,
  params,
  active,
}: {
  instanceId: string;
  pluginId: string;
  viewId: string;
  connectionId?: string;
  params?: Record<string, string>;
  active: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Open once per instance; params are fixed for an instance's lifetime.
  useEffect(() => {
    void window.oneclient.openView(instanceId, pluginId, viewId, connectionId, params);
    return () => void window.oneclient.closeView(instanceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  useEffect(() => {
    let disposed = false;

    const updateBounds = () => {
      if (disposed || !ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      const bounds = activeRef.current
        ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
        : { x: 0, y: 0, width: 0, height: 0 };
      void window.oneclient.setViewBounds(instanceId, bounds);
    };

    const observer = new ResizeObserver(updateBounds);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", updateBounds);
    updateBounds();

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, [instanceId, active]);

  return <div ref={ref} style={{ width: "100%", height: "100%" }} />;
}
