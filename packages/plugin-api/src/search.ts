import type { TreeNodeOpenView } from "./explorer.js";

/**
 * Global search ("Go to anything" in the top bar / Ctrl+P).
 *
 * A plugin takes part by declaring a search provider in its manifest:
 *
 *   "contributes": {
 *     "commands": [{ "id": "files.search", "title": "Files: Search", "hidden": true }],
 *     "searchProviders": [{ "id": "files", "label": "Files", "command": "files.search", "connectionType": "folder" }]
 *   }
 *
 * and handling that command. As the user types, core calls the command once per saved connection of the
 * plugin (opening the connection first if needed) with a {@link SearchRequest}, and shows what comes back
 * grouped by provider. Choosing a result opens its `openView` as a tab, or runs its `command`.
 * Providers run in parallel in their own processes; a slow or failing one never blocks the others.
 */
export interface SearchProviderContribution {
  readonly id: string;
  /** Group heading in the results ("Files", "SQL objects"). */
  readonly label: string;
  /** A `contributes.commands` id of this plugin, taking a {@link SearchRequest} and returning {@link SearchResult}[]. */
  readonly command: string;
  /** Only search connections of these types (defaults to every connection type of the plugin). */
  readonly connectionType?: string;
  /** Lower comes first among groups (default 100). */
  readonly order?: number;
  /** `$(icon)` for the group. */
  readonly icon?: string;
}

export interface SearchRequest {
  /** What the user typed (at least one non-space character). */
  readonly query: string;
  /** The connection to search in. */
  readonly connectionId: string;
  /** Return at most this many results; best matches first. */
  readonly limit: number;
}

/** One hit. Give it either an `openView` (opens a tab, like an explorer node) or a `command` (run, then its `openNode` result is opened). */
export interface SearchResult {
  /** Optional stable id of the thing found. Give a file's path (the same id its explorer node has) so opening it from search focuses the tab the explorer would open instead of making a second one. */
  readonly id?: string;
  readonly label: string;
  /** Dim text after the label: a folder path, a schema, a type. */
  readonly description?: string;
  /** `$(id)` registry icon. */
  readonly icon?: string;
  /** A file or folder name: the row then gets its icon from the active icon theme (and `icon` is the fallback). */
  readonly resource?: { readonly name: string; readonly kind: "file" | "folder" };
  /** Open this view of the plugin as a tab on the searched connection. */
  readonly openView?: TreeNodeOpenView;
  /** Or run this command of the plugin; the argument is `{ connectionId, ...args }` — the same shape explorer context commands get. */
  readonly command?: { readonly id: string; readonly args?: Readonly<Record<string, unknown>> };
}
