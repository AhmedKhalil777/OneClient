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

/**
 * VS Code-style file icon mappings. Values are icon ids that the theme itself
 * defines in its `icons` map (or any registry id). Keys are matched lower-case.
 */
export interface FileIconMappings {
  /** Extension without the dot; multi-part ones ("spec.ts", "d.ts") win over their last part ("ts"). */
  readonly fileExtensions?: Readonly<Record<string, string>>;
  /** Exact file names ("package.json", "dockerfile", ".gitignore") — beat extensions. */
  readonly fileNames?: Readonly<Record<string, string>>;
  /** Exact folder names ("src", "node_modules"). A leading/trailing `.`, `_` or `-` is ignored on lookup, so "src" also covers ".src" / "__src__". */
  readonly folderNames?: Readonly<Record<string, string>>;
  readonly folderNamesExpanded?: Readonly<Record<string, string>>;
}

/**
 * Shape of an icon theme file (`contributes.iconThemes[].path`). Everything is
 * optional: a theme may only restyle a few registry ids (`icons`), or also be a
 * full file-icon theme like VS Code's Seti / Material Icon Theme.
 */
export interface IconThemeFile extends FileIconMappings {
  /** Treat every icon this theme defines as multi-colour (drawn as-is) unless it says otherwise. */
  readonly colored?: boolean;
  /** Icon id → SVG path relative to this file. Defines new ids or restyles existing ones. */
  readonly icons?: Readonly<Record<string, string | { readonly path: string; readonly colored?: boolean }>>;
  /** Fallbacks when no mapping matches. */
  readonly file?: string;
  readonly folder?: string;
  readonly folderExpanded?: string;
  /** Overrides applied on top of the mappings above in light / high-contrast color themes. */
  readonly light?: FileIconMappings;
  readonly hc?: FileIconMappings;
}

/** The active icon theme's file mappings, resolved for the active color theme (light/hc overrides merged in). */
export interface FileIconAssociations {
  readonly file?: string | undefined;
  readonly folder?: string | undefined;
  readonly folderExpanded?: string | undefined;
  readonly fileExtensions: Readonly<Record<string, string>>;
  readonly fileNames: Readonly<Record<string, string>>;
  readonly folderNames: Readonly<Record<string, string>>;
  readonly folderNamesExpanded: Readonly<Record<string, string>>;
}

/** Characters ignored at the ends of a folder name when looking it up (".git", "_git", "__git__" ≈ "git"). */
const FOLDER_NAME_NOISE = /^[._-]+|[._-]+$/g;

/** Canonical lookup key for a folder name — what theme authors store and the resolver searches. */
export function normalizeFolderName(name: string): string {
  const lower = name.toLowerCase();
  return lower.replace(FOLDER_NAME_NOISE, "") || lower;
}

/**
 * Icon id for a file or folder under the active icon theme's file associations,
 * or undefined if the theme has none (the caller then uses the node's own icon).
 * Files: exact name, then the longest matching extension ("a.spec.ts" → "spec.ts" → "ts"), then the theme's `file`.
 * Folders: name (expanded variant when open), then the theme's `folder` / `folderExpanded`.
 */
export function resolveFileIcon(
  assoc: FileIconAssociations | undefined,
  name: string,
  kind: "file" | "folder",
  expanded = false,
): string | undefined {
  if (!assoc) return undefined;
  const lower = name.toLowerCase();
  if (kind === "folder") {
    const key = normalizeFolderName(name);
    return expanded
      ? (assoc.folderNamesExpanded[key] ?? assoc.folderNamesExpanded[lower] ?? assoc.folderExpanded ?? assoc.folderNames[key] ?? assoc.folder)
      : (assoc.folderNames[key] ?? assoc.folderNames[lower] ?? assoc.folder);
  }
  const byName = assoc.fileNames[lower];
  if (byName) return byName;
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const byExt = assoc.fileExtensions[parts.slice(i).join(".")];
    if (byExt) return byExt;
  }
  return assoc.file;
}

/** What core tells views about the active theme. */
export interface ThemeState {
  readonly colorTheme: { readonly id: string; readonly label: string; readonly kind: ThemeKind };
  readonly iconTheme: { readonly id: string; readonly label: string };
  /**
   * File/folder icon mappings of the active icon theme, if it has any. Large
   * (thousands of entries for full file-icon themes), so core only sends it to
   * the app shell, not to plugin views.
   */
  readonly fileIcons?: FileIconAssociations;
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
