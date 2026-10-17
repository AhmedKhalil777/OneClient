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

  /** Path, relative to the plugin root, to the compiled entry module run in the extension host. Must export `activate` (and optionally `deactivate`). */
  readonly main: string;

  /** Path, relative to the plugin root, to the Tier 2 UI bundle root. Required iff any `contributes.views[].tier === 2`. */
  readonly ui?: string;

  readonly contributes?: {
    readonly connectionTypes?: ConnectionTypeContribution[];
    readonly explorerNodes?: ExplorerNodeContribution[];
    readonly views?: ViewContribution[];
    readonly commands?: CommandContribution[];
  };

  /**
   * Events that trigger activation of this plugin's `main` module. Absent
   * or `["*"]` means activate eagerly at app start. Otherwise the plugin
   * stays dormant (no extension-host process spawned) until one fires,
   * e.g. `"onConnectionType:postgres"`, `"onCommand:postgres.runQuery"`,
   * `"onView:postgres.messageBrowser"`.
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
}

export interface CommandContribution {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
  readonly icon?: string;
  readonly keybinding?: string;
  /** Context-menu visibility guard, e.g. `"contextValue == 'postgres.table'"`. Omit to show only in the command palette. */
  readonly when?: string;
}
