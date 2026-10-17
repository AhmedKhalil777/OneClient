import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import {
  type FileIconAssociations,
  type FileIconMappings,
  type IconThemeFile,
  THEME_COLOR_KEYS,
  type ThemeKind,
  type ThemeState,
  normalizeFolderName,
} from "@oneclient/plugin-api";
import type { ContributionRegistrySnapshot } from "../../shared/types.js";
import { BUILTIN_COLOR_THEMES, DEFAULT_COLOR_THEME, DEFAULT_ICON_THEME, PREFERRED_FILE_ICON_THEME, baseColorsFor } from "./builtin-themes.js";

export interface ThemeListItem {
  id: string;
  label: string;
  kind?: ThemeKind;
  /** Contributing plugin; absent for built-ins. */
  pluginId?: string;
}

interface IconEntry {
  file: string;
  colored: boolean;
}

interface Settings {
  colorTheme?: string;
  iconTheme?: string;
}

const KNOWN_COLOR_KEYS = new Set<string>(THEME_COLOR_KEYS);
const ICON_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Owns the active color theme and icon theme. Built-ins live in core; plugins
 * add more through `contributes.themes` / `iconThemes` / `icons`. The choice
 * is persisted to settings.json and pushed to the shell and every view.
 */
export class ThemeService {
  private settings: Settings;
  private colorThemeId: string;
  /** The user's explicit icon theme choice; undefined = "no choice yet" → the best available default. */
  private iconThemeId: string | undefined;
  private iconVersion = 1;
  private state!: ThemeState;
  private icons = new Map<string, IconEntry>();
  /** Parsed file of the active icon theme (file/folder mappings), if it has one. */
  private iconThemeFile: IconThemeFile | null = null;
  private readonly listeners = new Set<(state: ThemeState) => void>();

  constructor(
    private readonly opts: {
      getRegistry: () => ContributionRegistrySnapshot;
      getPluginRoot: (pluginId: string) => string | undefined;
      builtinIconDir: string;
      settingsPath: string;
      log: (message: string) => void;
    },
  ) {
    this.settings = this.readSettings();
    this.colorThemeId = this.settings.colorTheme ?? DEFAULT_COLOR_THEME;
    this.iconThemeId = this.settings.iconTheme;
    this.recompute();
  }

  getState(): ThemeState {
    return this.state;
  }

  onChanged(listener: (state: ThemeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listColorThemes(): ThemeListItem[] {
    return [
      ...BUILTIN_COLOR_THEMES.map(({ id, label, kind }) => ({ id, label, kind })),
      ...this.opts.getRegistry().themes.map((t) => ({ id: t.id, label: t.label, kind: t.uiTheme, pluginId: t.pluginId })),
    ];
  }

  listIconThemes(): ThemeListItem[] {
    return [
      { id: DEFAULT_ICON_THEME, label: "oneClient Default" },
      ...this.opts.getRegistry().iconThemes.map((t) => ({ id: t.id, label: t.label, pluginId: t.pluginId })),
    ];
  }

  /** `persist: false` is a preview (theme picker hovering) — applied but not saved. */
  setColorTheme(id: string, persist = true): void {
    if (!this.listColorThemes().some((t) => t.id === id)) throw new Error(`Unknown color theme "${id}".`);
    this.colorThemeId = id;
    if (persist) this.saveSettings({ ...this.settings, colorTheme: id });
    this.recompute(false);
  }

  setIconTheme(id: string, persist = true): void {
    if (!this.listIconThemes().some((t) => t.id === id)) throw new Error(`Unknown icon theme "${id}".`);
    this.iconThemeId = id;
    if (persist) this.saveSettings({ ...this.settings, iconTheme: id });
    this.recompute(true);
  }

  /** Plugins came or went: their themes/icons may have changed. */
  onRegistryChanged(): void {
    this.recompute(true);
  }

  /** Absolute SVG path for an icon id in the active icon theme (for the asset protocol). */
  resolveIconFile(id: string): string | undefined {
    return this.icons.get(id)?.file;
  }

  // ---- internals ----

  /**
   * The icon theme in effect: the user's choice if it still exists, otherwise
   * (no choice, or its plugin was uninstalled) the preferred file-icon theme if
   * one is installed, otherwise oneClient's plain default.
   */
  private effectiveIconThemeId(): string {
    const ids = new Set(this.listIconThemes().map((t) => t.id));
    if (this.iconThemeId && ids.has(this.iconThemeId)) return this.iconThemeId;
    return ids.has(PREFERRED_FILE_ICON_THEME) ? PREFERRED_FILE_ICON_THEME : DEFAULT_ICON_THEME;
  }

  private recompute(iconsChanged = true): void {
    const registry = this.opts.getRegistry();

    // Colors: built-in base for the theme's kind, overlaid with the theme's own values.
    let color = BUILTIN_COLOR_THEMES.find((t) => t.id === this.colorThemeId);
    let colors: Record<string, string>;
    let label: string;
    let kind: ThemeKind;
    const contributed = registry.themes.find((t) => t.id === this.colorThemeId);
    if (color) {
      ({ colors, label, kind } = { colors: color.colors, label: color.label, kind: color.kind });
    } else if (contributed) {
      kind = contributed.uiTheme;
      label = contributed.label;
      colors = { ...baseColorsFor(kind), ...this.loadThemeColors(contributed.pluginId, contributed.path) };
    } else {
      // Remembered theme's plugin isn't installed (any more): fall back, but keep the saved choice.
      color = BUILTIN_COLOR_THEMES.find((t) => t.id === DEFAULT_COLOR_THEME)!;
      ({ colors, label, kind } = { colors: color.colors, label: color.label, kind: color.kind });
    }
    const colorThemeId = color?.id ?? contributed?.id ?? DEFAULT_COLOR_THEME;

    // Icons: built-in set + plugin-registered ids, then the active icon theme's definitions.
    const iconThemeId = this.effectiveIconThemeId();
    if (iconsChanged) {
      this.icons = this.loadIcons(registry, iconThemeId);
      this.iconVersion++;
    }
    const iconTheme = this.listIconThemes().find((t) => t.id === iconThemeId)!;
    const fileIcons = this.buildFileIcons(kind);

    this.state = {
      colorTheme: { id: colorThemeId, label, kind },
      iconTheme: { id: iconTheme.id, label: iconTheme.label },
      ...(fileIcons ? { fileIcons } : {}),
      colors,
      icons: Object.fromEntries([...this.icons].map(([id, e]) => [id, { colored: e.colored }])),
      iconVersion: this.iconVersion,
    };
    for (const listener of this.listeners) listener(this.state);
  }

  private loadIcons(registry: ContributionRegistrySnapshot, iconThemeId: string): Map<string, IconEntry> {
    const icons = new Map<string, IconEntry>();
    this.iconThemeFile = null;
    if (existsSync(this.opts.builtinIconDir)) {
      for (const file of readdirSync(this.opts.builtinIconDir)) {
        if (file.endsWith(".svg")) icons.set(basename(file, ".svg"), { file: resolve(this.opts.builtinIconDir, file), colored: false });
      }
    }
    // New ids from plugins; built-in ids can only be restyled by an icon theme, not taken over.
    for (const icon of registry.icons) {
      if (icons.has(icon.id) || !ICON_ID.test(icon.id)) continue;
      const file = this.pluginFile(icon.pluginId, icon.path);
      if (file) icons.set(icon.id, { file, colored: icon.colored ?? false });
    }
    const theme = registry.iconThemes.find((t) => t.id === iconThemeId);
    if (theme) {
      const json = this.readPluginJson(theme.pluginId, theme.path) as IconThemeFile | null;
      const root = this.opts.getPluginRoot(theme.pluginId);
      const themeDir = root ? resolve(root, theme.path, "..") : undefined;
      this.iconThemeFile = json;
      for (const [id, value] of Object.entries(json?.icons ?? {})) {
        const entry = typeof value === "string" ? { path: value, colored: undefined } : value;
        // Paths in the theme file are relative to that file.
        const file = themeDir && root ? this.within(root, resolve(themeDir, entry.path)) : undefined;
        if (file && ICON_ID.test(id)) icons.set(id, { file, colored: entry.colored ?? json?.colored ?? false });
      }
    }
    return icons;
  }

  /**
   * The icon theme's file/folder mappings for the active color theme kind
   * (its light/hc overrides merged in), keeping only entries whose icon id
   * actually exists — a broken mapping must fall through to the default icon
   * rather than draw a missing image.
   */
  private buildFileIcons(kind: ThemeKind): FileIconAssociations | undefined {
    const f = this.iconThemeFile;
    if (!f) return undefined;
    const known = (id: string | undefined) => (id && this.icons.has(id) ? id : undefined);
    const override: FileIconMappings | undefined = kind === "light" ? f.light : kind === "hc" ? f.hc : undefined;
    const table = (key: keyof FileIconMappings, normalize: (k: string) => string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const source of [f[key], override?.[key]]) {
        for (const [name, id] of Object.entries(source ?? {})) {
          if (this.icons.has(id)) out[normalize(name)] = id;
        }
      }
      return out;
    };
    const lower = (k: string) => k.toLowerCase();
    const assoc: FileIconAssociations = {
      file: known(f.file),
      folder: known(f.folder),
      folderExpanded: known(f.folderExpanded),
      fileExtensions: table("fileExtensions", (k) => lower(k).replace(/^\./, "")),
      fileNames: table("fileNames", lower),
      folderNames: table("folderNames", normalizeFolderName),
      folderNamesExpanded: table("folderNamesExpanded", normalizeFolderName),
    };
    const hasAny =
      assoc.file || assoc.folder || assoc.folderExpanded || Object.keys(assoc.fileExtensions).length + Object.keys(assoc.fileNames).length + Object.keys(assoc.folderNames).length > 0;
    return hasAny ? assoc : undefined;
  }

  private loadThemeColors(pluginId: string, path: string): Record<string, string> {
    const json = this.readPluginJson(pluginId, path) as { colors?: Record<string, unknown> } | null;
    const colors: Record<string, string> = {};
    for (const [key, value] of Object.entries(json?.colors ?? {})) {
      if (KNOWN_COLOR_KEYS.has(key) && typeof value === "string") colors[key] = value;
      else this.opts.log(`theme ${pluginId}/${path}: ignoring unknown color "${key}"`);
    }
    return colors;
  }

  private readPluginJson(pluginId: string, path: string): unknown {
    const file = this.pluginFile(pluginId, path);
    if (!file) return null;
    try {
      return JSON.parse(readFileSync(file, "utf-8"));
    } catch (err) {
      this.opts.log(`theme ${pluginId}/${path}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** A file inside the plugin's root (path-traversal safe), if it exists. */
  private pluginFile(pluginId: string, relativePath: string): string | undefined {
    const root = this.opts.getPluginRoot(pluginId);
    return root ? this.within(root, resolve(root, relativePath)) : undefined;
  }

  private within(root: string, file: string): string | undefined {
    const r = resolve(root);
    return (file === r || file.startsWith(r + sep)) && existsSync(file) ? file : undefined;
  }

  private readSettings(): Settings {
    try {
      return JSON.parse(readFileSync(this.opts.settingsPath, "utf-8")) as Settings;
    } catch {
      return {};
    }
  }

  private saveSettings(next: Settings): void {
    this.settings = next;
    try {
      writeFileSync(this.opts.settingsPath, JSON.stringify(next, null, 2));
    } catch (err) {
      this.opts.log(`could not save settings: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
