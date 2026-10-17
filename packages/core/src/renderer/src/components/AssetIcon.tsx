/**
 * Renders a plugin-declared icon (manifest `icon`, or a contribution's own
 * `icon`) as a real `<img>`. The path is always relative to that plugin's
 * install directory — never resolved on the renderer side — and is served
 * through the `oneclient-asset://` protocol the main process registers
 * (see main/assets/plugin-asset-protocol.ts), which is sandboxed to that
 * one plugin's own root directory.
 */
export function AssetIcon({
  pluginId,
  icon,
  size = 16,
  fallback = "🧩",
}: {
  pluginId: string;
  icon?: string;
  size?: number;
  fallback?: string;
}) {
  if (!icon) {
    return (
      <span style={{ fontSize: size, lineHeight: 1, display: "inline-block", width: size, textAlign: "center" }}>
        {fallback}
      </span>
    );
  }
  return (
    <img
      src={`oneclient-asset://${pluginId}/${icon}`}
      width={size}
      height={size}
      style={{ display: "inline-block", objectFit: "contain", flexShrink: 0 }}
      alt=""
    />
  );
}
