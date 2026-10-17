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
  return `oneclient-asset://oneclient.icons/${encodeURIComponent(id)}.svg?v=${theme?.iconVersion ?? 0}`;
}
