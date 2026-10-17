import { createContext, useContext, useEffect, useState } from "react";
import { type ThemeState, colorVarName, iconUrl, parseIconRef, resolveFileIcon } from "@oneclient/plugin-api";

export { parseIconRef };

/**
 * Shell side of the theme system: loads the active theme from main, applies
 * every color as a `--oc-*` CSS variable on <html>, and re-applies on change.
 * (Plugin views get the same variables from their own preload.)
 */
const ThemeContext = createContext<ThemeState | null>(null);

function apply(state: ThemeState) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(state.colors)) root.style.setProperty(colorVarName(key), value);
  root.dataset.ocTheme = state.colorTheme.kind;
  root.style.colorScheme = state.colorTheme.kind === "light" ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ThemeState | null>(null);
  useEffect(() => {
    const update = (s: ThemeState) => {
      apply(s);
      setState(s);
    };
    void window.oneclient.getThemeState().then(update);
    return window.oneclient.onThemeChanged(update);
  }, []);
  return <ThemeContext.Provider value={state}>{children}</ThemeContext.Provider>;
}

export function useThemeState(): ThemeState | null {
  return useContext(ThemeContext);
}

/**
 * The icon for a file/folder (`TreeNode.resource`) under the active icon theme's
 * file associations, as a `$(id)` icon reference — or undefined if the theme
 * has none, so the caller keeps the node's own icon.
 */
export function useResourceIcon(resource: { name: string; kind: "file" | "folder" } | undefined, expanded = false): string | undefined {
  const theme = useThemeState();
  if (!resource) return undefined;
  const id = resolveFileIcon(theme?.fileIcons, resource.name, resource.kind, expanded);
  return id ? `$(${id})` : undefined;
}

/**
 * An icon from the icon registry (`$(id)` ids). Monochrome icons are drawn as
 * a CSS mask filled with `currentColor`, so they take the surrounding text
 * color of whatever theme is active; `colored` icons are drawn as-is.
 */
export function ThemeIcon({ id, size = 16, title, className }: { id: string; size?: number; title?: string; className?: string }) {
  const theme = useThemeState();
  const url = iconUrl(id, theme?.iconVersion ?? 0);
  const entry = theme?.icons[id];
  if (entry?.colored) {
    return <img src={url} width={size} height={size} alt="" title={title} className={className} style={{ flexShrink: 0 }} />;
  }
  return (
    <span
      role="img"
      aria-label={title ?? id}
      title={title}
      className={`theme-icon ${className ?? ""}`}
      style={{ width: size, height: size, WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")` }}
    />
  );
}
