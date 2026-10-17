/**
 * Theme & icon system — VS Code's model, trimmed down.
 *
 * COLORS. Core defines a fixed set of color keys (`editor.background`,
 * `sideBar.background`, `terminal.ansiRed`, `syntax.keyword`, …; see
 * THEME_COLOR_KEYS). A color theme assigns values to them. Every key is
 * available to every view as a CSS custom property — dots become dashes,
 * prefixed with `--oc-`:  `editor.background` → `var(--oc-editor-background)`.
 * Core injects these into Tier 2 views automatically; style plugin UIs with
 * them (plus a fallback) and they follow the user's theme for free.
 *
 * ICONS. Core ships a product icon set (`folder`, `file`, `database`,
 * `table`, `terminal`, `refresh`, …). Anywhere an icon is accepted
 * (TreeNode.icon, manifest `icon` fields) a plugin can write `$(id)` to use
 * one instead of shipping its own SVG. Plugins can register more ids
 * (`contributes.icons`) for other plugins to reuse, and icon themes
 * (`contributes.iconThemes`) can restyle any id.
 */

export type ThemeKind = "dark" | "light" | "hc";

/** `contributes.themes[]` — a color theme shipped by a plugin. */
export interface ColorThemeContribution {
  readonly id: string;
  readonly label: string;
  /** Base theme: unset colors fall back to the built-in theme of this kind. */
  readonly uiTheme: ThemeKind;
  /** Path (relative to the plugin root) to a JSON file: `{ "colors": { "editor.background": "#002b36", … } }`. */
  readonly path: string;
}

/** `contributes.iconThemes[]` — restyles icon ids. */
export interface IconThemeContribution {
  readonly id: string;
  readonly label: string;
  /**
   * Path to a JSON file: `{ "icons": { "<icon id>": "relative/path.svg" | { "path": "…", "colored": true } } }`.
   * Ids it doesn't list keep their default icon.
   */
  readonly path: string;
}

/** `contributes.icons[]` — registers a new icon id other plugins can use as `$(id)`. */
export interface IconContribution {
  /** Lower-case, dash-separated, ideally prefixed with the plugin's domain: "docker-container". */
  readonly id: string;
  readonly description?: string;
  /** SVG path relative to the plugin root. */
  readonly path: string;
  /**
   * Multi-colour artwork, drawn as-is. Default false: the SVG is used as a
   * shape (mask) and painted in the current text colour, so it follows the theme.
   */
  readonly colored?: boolean;
}

/** What core tells views about the active theme. */
export interface ThemeState {
  readonly colorTheme: { readonly id: string; readonly label: string; readonly kind: ThemeKind };
  readonly iconTheme: { readonly id: string; readonly label: string };
  /** Every color key → resolved value (built-in defaults already merged in). */
  readonly colors: Readonly<Record<string, string>>;
  /** Icon id → how to draw it. URL: `oneclient-asset://oneclient.icons/<id>.svg?v=<iconVersion>`. */
  readonly icons: Readonly<Record<string, { readonly colored: boolean }>>;
  /** Changes whenever icon files change (theme switch) — append to icon URLs to bust caches. */
  readonly iconVersion: number;
}

/** CSS custom property for a color key: `editor.background` → `--oc-editor-background`. */
export function colorVarName(key: string): string {
  return `--oc-${key.replace(/\./g, "-")}`;
}

/** URL of an icon id in the active icon theme. */
export function iconUrl(id: string, version = 0): string {
  return `oneclient-asset://oneclient.icons/${encodeURIComponent(id)}.svg?v=${version}`;
}

/** `"$(database)"` → `"database"`; anything else (a plugin-relative path) → undefined. */
export function parseIconRef(icon: string | undefined): string | undefined {
  const m = icon ? /^\$\(([a-z0-9][a-z0-9-]*)\)$/.exec(icon) : null;
  return m?.[1];
}

/** Every color key core defines, grouped like VS Code's. Themes may set any subset. */
export const THEME_COLOR_KEYS = [
  // base
  "foreground",
  "descriptionForeground",
  "errorForeground",
  "warningForeground",
  "successForeground",
  "focusBorder",
  "widget.border",
  "widget.background",
  "widget.shadow",
  "textLink.foreground",
  // editor
  "editor.background",
  "editor.foreground",
  "editor.selectionBackground",
  "editor.lineHighlightBackground",
  "editorLineNumber.foreground",
  "editorLineNumber.activeForeground",
  "editorCursor.foreground",
  // workbench
  "activityBar.background",
  "activityBar.foreground",
  "activityBar.inactiveForeground",
  "activityBar.activeBorder",
  "sideBar.background",
  "sideBar.foreground",
  "sideBar.border",
  "sideBarSectionHeader.background",
  "editorGroupHeader.tabsBackground",
  "tab.activeBackground",
  "tab.activeForeground",
  "tab.inactiveBackground",
  "tab.inactiveForeground",
  "tab.activeBorderTop",
  "tab.border",
  "panel.background",
  "panel.border",
  "panelTitle.activeForeground",
  "panelTitle.inactiveForeground",
  "panelTitle.activeBorder",
  "statusBar.background",
  "statusBar.foreground",
  "statusBarItem.hoverBackground",
  "titleBar.background",
  // lists & trees
  "list.hoverBackground",
  "list.activeSelectionBackground",
  "list.activeSelectionForeground",
  "list.highlightForeground",
  // controls
  "input.background",
  "input.foreground",
  "input.border",
  "input.placeholderForeground",
  "dropdown.background",
  "button.background",
  "button.foreground",
  "button.hoverBackground",
  "button.secondaryBackground",
  "button.secondaryForeground",
  "button.secondaryHoverBackground",
  "badge.background",
  "badge.foreground",
  "menu.background",
  "menu.foreground",
  "menu.selectionBackground",
  "menu.selectionForeground",
  "menu.border",
  "scrollbarSlider.background",
  "scrollbarSlider.hoverBackground",
  "scrollbarSlider.activeBackground",
  // results grids
  "grid.headerBackground",
  "grid.border",
  "grid.nullForeground",
  // syntax (for plugin editors)
  "syntax.keyword",
  "syntax.operator",
  "syntax.type",
  "syntax.function",
  "syntax.string",
  "syntax.comment",
  "syntax.number",
  "syntax.variable",
  // terminal
  "terminal.background",
  "terminal.foreground",
  "terminalCursor.foreground",
  "terminal.selectionBackground",
  "terminal.ansiBlack",
  "terminal.ansiRed",
  "terminal.ansiGreen",
  "terminal.ansiYellow",
  "terminal.ansiBlue",
  "terminal.ansiMagenta",
  "terminal.ansiCyan",
  "terminal.ansiWhite",
  "terminal.ansiBrightBlack",
  "terminal.ansiBrightRed",
  "terminal.ansiBrightGreen",
  "terminal.ansiBrightYellow",
  "terminal.ansiBrightBlue",
  "terminal.ansiBrightMagenta",
  "terminal.ansiBrightCyan",
  "terminal.ansiBrightWhite",
] as const;

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
