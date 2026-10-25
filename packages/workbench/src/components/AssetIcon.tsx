/**
 * Renders a plugin-declared icon (manifest `icon`, or a contribution's own
 * `icon`) as a real `<img>`. The path is always relative to that plugin's
 * install directory — never resolved on the renderer side — and is served
 * through the `oneclient-asset://` protocol the main process registers
 * (see main/assets/plugin-asset-protocol.ts), which is sandboxed to that
 * one plugin's own root directory.
 */
import { assetUrl } from "@oneclient/plugin-api";
import { ThemeIcon, parseIconRef } from "../theme.js";

/** `icon` may also be `$(id)` — an id from the icon registry (built-in or plugin-registered), drawn via the active icon theme. */
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
  const iconId = parseIconRef(icon);
  if (iconId) return <ThemeIcon id={iconId} size={size} />;
  if (!icon) {
    return (
      <span style={{ fontSize: size, lineHeight: 1, display: "inline-block", width: size, textAlign: "center", flexShrink: 0 }}>
        {fallback}
      </span>
    );
  }
  return (
    <img
      src={assetUrl(pluginId, icon)}
      width={size}
      height={size}
      style={{ display: "inline-block", objectFit: "contain", flexShrink: 0 }}
      alt=""
    />
  );
}
