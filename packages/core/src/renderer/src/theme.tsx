import { createContext, useContext, useEffect, useState } from "react";
import type { ThemeState } from "@oneclient/plugin-api";

/**
 * Shell side of the theme system: loads the active theme from main, applies
 * every color as a `--oc-*` CSS variable on <html>, and re-applies on change.
 * (Plugin views get the same variables from their own preload.)
 */
const ThemeContext = createContext<ThemeState | null>(null);

export const colorVarName = (key: string) => `--oc-${key.replace(/\./g, "-")}`;

/** `"$(database)"` → `"database"`; plugin-relative paths → undefined. Mirrors plugin-api's parseIconRef. */
export function parseIconRef(icon: string | undefined): string | undefined {
  const m = icon ? /^\$\(([a-z0-9][a-z0-9-]*)\)$/.exec(icon) : null;
  return m?.[1];
}

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
 * An icon from the icon registry (`$(id)` ids). Monochrome icons are drawn as
 * a CSS mask filled with `currentColor`, so they take the surrounding text
 * color of whatever theme is active; `colored` icons are drawn as-is.
 */
export function ThemeIcon({ id, size = 16, title, className }: { id: string; size?: number; title?: string; className?: string }) {
  const theme = useThemeState();
  const url = `oneclient-asset://oneclient.icons/${encodeURIComponent(id)}.svg?v=${theme?.iconVersion ?? 0}`;
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
