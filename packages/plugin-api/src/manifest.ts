import type { SearchProviderContribution } from "./search.js";
import type { JsonSchemaObject } from "./json-schema.js";
import type { ColorThemeContribution, IconContribution, IconThemeContribution } from "./theme.js";

/**
 * Shape of `oneclient.json`. This TS type and
 * `schema/oneclient-manifest.schema.json` describe the same thing by hand —
 * keep them in sync when either changes. (A generator from one to the
 * other is a reasonable Phase 2+ follow-up; hand-written is fine while the
 * shape is still moving.)
 *
 * The core NEVER imports plugin code to decide what to show in the UI —
 * it parses this manifest and renders contributions generically. Plugin
 * code is only activated lazily, the first time one of its contributions
 * is actually used (see `activationEvents`).
 */
export interface PluginManifest {
  /** Unique id, conventionally `oneclient-<tool>` (e.g. "oneclient-postgres"). */
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly version: string;
  readonly publisher?: string;
  readonly icon?: string;
  readonly license?: string;
  readonly repository?: string;

  readonly engines: {
    /** Semver range against `PLUGIN_API_VERSION`, e.g. "^0.1.0". */
    readonly oneclient: string;
  };

  /**
   * Path, relative to the plugin root, to the compiled entry module run in the extension host. Must export
   * `activate` (and optionally `deactivate`). Omit for declarative plugins that only contribute data
   * (themes, icons) — no extension-host process is started for those.
   */
  readonly main?: string;

  /** Path, relative to the plugin root, to the Tier 2 UI bundle root. Required iff any `contributes.views[].tier === 2`. */
  readonly ui?: string;

  readonly contributes?: {
    readonly connectionTypes?: ConnectionTypeContribution[];
    readonly explorerNodes?: ExplorerNodeContribution[];
    /**
     * Extra collapsible sections in the plugin's sidebar, under Connections (like Source Control's
     * "Changes" / "Graph" sections in VS Code). Each shows, per saved connection, the children of a
     * `rootNodeType` node from the plugin's explorer provider. See ExplorerSectionContribution.
     */
    readonly explorerSections?: ExplorerSectionContribution[];
    readonly views?: ViewContribution[];
    readonly commands?: CommandContribution[];
    /** Color themes (see theme.ts). */
    readonly themes?: ColorThemeContribution[];
    /** Icon themes that restyle icon ids. */
    readonly iconThemes?: IconThemeContribution[];
    /** Take part in the global search (top bar / Ctrl+P) — see search.ts. */
    readonly searchProviders?: SearchProviderContribution[];
    /** New icon ids, usable by any plugin as `$(id)`. */
    readonly icons?: IconContribution[];
    /** Items in the title bar menus (File, Edit, View, Go, Run, Terminal, Help). */
    readonly menus?: MenuContribution[];
    /**
     * Contributions to other plugins' extension points, keyed by point id (`<owning plugin id>.<name>`).
     * Core only brokers them (views read them with `ViewHostApi.getContributions`); the plugin that owns the
     * point defines and validates the item shape. Example: core's `"oneclient.editors"` — see file-editor.ts.
     */
    readonly extensions?: Record<string, ReadonlyArray<Record<string, unknown>>>;
  };

  /**
   * Events that trigger activation of this plugin's `main` module, e.g.
   * `"onConnectionType:postgres"`, `"onCommand:postgres.runQuery"`,
   * `"onView:postgres.messageBrowser"`. Absent or `["*"]` means eager.
   * Note: core currently activates every enabled plugin at app start
   * regardless, so each plugin's explorer is live in the activity bar.
   */
  readonly activationEvents?: string[];
}

export interface ConnectionTypeContribution {
  /** Referenced by `ConnectionProvider.typeId` at runtime. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly category?: string;
  /**
   * What one saved connection of this type is called in the UI, e.g. "Folder", "Server", "Cluster" — used for
   * "Add Server", "Remove Server", "No servers yet". Default "Connection".
   */
  readonly connectionLabel?: string;
  /** Plural of `connectionLabel`, the sidebar section heading (e.g. "Servers"). Default: `connectionLabel` + "s". */
  readonly connectionLabelPlural?: string;
}

export type MenuId = "file" | "edit" | "view" | "go" | "run" | "terminal" | "help";

/**
 * An item in one of the title bar menus. It either runs a `command` of this plugin, or — with only a
 * `keybinding` — presses that key in the active editor tab (which must be one of this plugin's views), so a menu
 * item can trigger what the view already does on a shortcut (Run ▸ Execute Query = F5 in a query tab).
 *
 * ```json
 * "menus": [
 *   { "menu": "run", "title": "Execute Query", "keybinding": "F5", "when": "activeView == 'postgres.query'" },
 *   { "menu": "file", "title": "New Query", "command": "postgres.newQuery" }
 * ]
 * ```
 */
export interface MenuContribution {
  readonly menu: MenuId;
  /** Defaults to the command's title. */
  readonly title?: string;
  readonly command?: string;
  /** Shown next to the item; pressed in the active view when there's no `command`. E.g. "F5", "Ctrl+Enter", "Shift+F5". */
  readonly keybinding?: string;
  /**
   * When to show the item. Keys: `activeView` (view id of the active editor tab), `activePlugin`, plus the
   * operators of `CommandContribution.when`. Omit to always show it.
   */
  readonly when?: string;
  /** Items with the same group sit together, separated from other groups. */
  readonly group?: string;
}

export interface ExplorerSectionContribution {
  readonly id: string;
  /** Section heading, e.g. "Fakers". */
  readonly title: string;
  /**
   * Node type the section asks the explorer provider about: core shows one row per connection (named after it)
   * whose children come from `getChildren({ nodeType: rootNodeType, contextValue: rootNodeType, … })`.
   * List it in the provider's `nodeTypes` and in `explorerNodes` (without `connectionType`, so it stays out of the
   * main tree). Context-menu commands can target it with `when: "contextValue == '<rootNodeType>'"`.
   */
  readonly rootNodeType: string;
  /** Only connections of this type (default: all of the plugin's). */
  readonly connectionType?: string;
  /** Start collapsed (default expanded). */
  readonly collapsed?: boolean;
}

export interface ExplorerNodeContribution {
  /** Referenced by `ExplorerProvider.nodeTypes` / `TreeNode.nodeType` at runtime. */
  readonly id: string;
  readonly label?: string;
  /** nodeType of the parent this attaches under; omit to attach at the connection root. */
  readonly parentNodeType?: string;
  /** Restrict this node to a specific connection type id. */
  readonly connectionType?: string;
  readonly icon?: string;
}

export interface ViewContribution {
  readonly id: string;
  readonly title: string;
  readonly tier: 1 | 2;
  readonly location: "sidebar" | "panel" | "editor";
  readonly icon?: string;
  /** Path, relative to `manifest.ui`, to this view's entry HTML. Required iff `tier === 2`. */
  readonly entry?: string;
  /**
   * If set, this view is scoped to one saved connection of that type —
   * core offers it as a per-connection action (e.g. "Open Dashboard" next
   * to a connection in the sidebar) rather than a standalone command, and
   * every message the view's backend handler receives carries the
   * relevant `connectionId` (see `ViewMessageContext`). Omit for a
   * connection-agnostic view.
   */
  readonly connectionType?: string;
}

export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly icon?: string;
  readonly keybinding?: string;
  /** Not offered in the command palette or plugin sections: the command exists only to be invoked by code (e.g. by a view or another plugin's extension point). */
  readonly hidden?: boolean;
  /**
   * Context-menu visibility guard. Omit to show the command in the command
   * palette (and the plugin's Commands section) instead.
   *
   * Grammar: terms joined by `&&` / `||` (`&&` binds tighter). A term is
   * `key == 'value'`, `key != 'value'`, `key =~ /regex/`, `key`, or `!key`.
   * Keys: `contextValue` (the right-clicked TreeNode's, or `'connection'`
   * for a connection row), `nodeType`, and `connectionType`.
   * E.g. `"contextValue == 'connection' && connectionType == 'docker'"`.
   *
   * When run from a context menu, `args[0]` is
   * `{ connectionId, ...node.data, node }` (`node` absent for a connection
   * row), merged with the `inputSchema` answers if any.
   */
  readonly when?: string;
  /**
   * If set, core asks the user to confirm before running (e.g. a delete).
   * `{label}` is replaced with the right-clicked item's label.
   */
  readonly confirm?: string;
  /**
   * If present, core collects one object matching this JSON Schema via a
   * generic Tier 1 form (reusing the same renderer as a connection config
   * form) before invoking the command, and passes it as `args[0]` —
   * e.g. a "Pull Image" command asking for an image tag. Omit for
   * commands that need no input, or that interpret `args` themselves
   * (e.g. a context-menu command receiving the clicked TreeNode).
   * A string `default` may contain `{label}` (the right-clicked item's
   * label), e.g. to prefill a rename field.
   */
  readonly inputSchema?: JsonSchemaObject;
}
