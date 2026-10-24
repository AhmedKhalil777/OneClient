import type { ThemeState } from "@oneclient/plugin-api";

/**
 * Theme helpers for plugin views. Core already applies every color to the
 * view as a `--oc-*` CSS variable, so CSS rarely needs these — they're for
 * code that needs actual values (canvas, xterm.js) or icon URLs.
 */

interface ThemeHost {
  getTheme(): ThemeState | null;
  onThemeChange(listener: (theme: ThemeState) => void): () => void;
}

function host(): ThemeHost | undefined {
  return (globalThis as { oneclientView?: ThemeHost }).oneclientView;
}

/** `var(--oc-editor-background, <fallback>)` for a color key. */
export function colorVar(key: string, fallback?: string): string {
  const name = `--oc-${key.replace(/\./g, "-")}`;
  return fallback ? `var(${name}, ${fallback})` : `var(${name})`;
}

export function getTheme(): ThemeState | null {
  return host()?.getTheme() ?? null;
}

/** Subscribe to theme changes (fires immediately if a theme is already loaded). */
export function onThemeChange(listener: (theme: ThemeState) => void): () => void {
  return host()?.onThemeChange(listener) ?? (() => undefined);
}

/** URL of a registry icon (`$(id)` ids), in the active icon theme. */
export function iconUrl(id: string, theme: ThemeState | null = getTheme()): string {
  // The web shell serves assets over HTTP and tells views where (see plugin-api's assetBase()).
  const base = (globalThis as { __ONECLIENT_ASSET_BASE__?: string }).__ONECLIENT_ASSET_BASE__ ?? "oneclient-asset://";
  return `${base}oneclient.icons/${encodeURIComponent(id)}.svg?v=${theme?.iconVersion ?? 0}`;
}

/**
 * A `:root { --oc-…: …; }` rule with every color of the active theme, as CSS text — for content
 * rendered outside the view's own document (a sandboxed preview iframe, a generated HTML page)
 * that should still follow the theme. Empty until the theme has loaded.
 */
export function themeCssText(theme: ThemeState | null = getTheme()): string {
  if (!theme) return "";
  const vars = Object.entries(theme.colors)
    .map(([key, value]) => `--oc-${key.replace(/\./g, "-")}:${value};`)
    .join("");
  const scheme = theme.colorTheme.kind === "light" ? "light" : "dark";
  return `:root{color-scheme:${scheme};${vars}}`;
}
