import { useEffect, useRef } from "react";

/**
 * Hosts one Tier 2 view instance. The actual content lives in a native
 * `WebContentsView` layered over this div by the main process (see
 * ViewHostManager) — this component's only job is telling main where
 * that div currently is (via ResizeObserver) and when to open/close it.
 * Nothing is rendered inside this div itself.
 */
export function Tier2ViewHost({
  instanceId,
  pluginId,
  viewId,
  connectionId,
}: {
  instanceId: string;
  pluginId: string;
  viewId: string;
  connectionId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    void window.oneclient.openView(instanceId, pluginId, viewId, connectionId);

    const updateBounds = () => {
      if (disposed || !ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      void window.oneclient.setViewBounds(instanceId, {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };

    const observer = new ResizeObserver(updateBounds);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", updateBounds);
    updateBounds();

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
      void window.oneclient.closeView(instanceId);
    };
  }, [instanceId, pluginId, viewId, connectionId]);

  return <div ref={ref} style={{ width: "100%", height: "100%" }} />;
}
