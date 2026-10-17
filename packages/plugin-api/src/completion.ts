/**
 * Autocomplete contract shared by plugin backends and editor UIs.
 *
 * Pure types (no runtime) so a plugin's extension-host side can build
 * `CompletionItem[]` and return them from a command, and its Tier 2 editor
 * can hand them straight to `@oneclient/editor-kit`'s autocomplete — which
 * owns the popup, filtering, ranking and keyboard handling.
 */

export type CompletionItemKind =
  | "keyword"
  | "function"
  | "method"
  | "variable"
  | "constant"
  | "type"
  | "snippet"
  | "text"
  | "file"
  | "folder"
  | "database"
  | "schema"
  | "table"
  | "view"
  | "column"
  | "procedure"
  | "field"
  | "property"
  | "module";

export interface CompletionItem {
  /** Shown in the list, and (unless `filterText`/`insertText` say otherwise) what's matched and inserted. */
  readonly label: string;
  readonly kind?: CompletionItemKind;
  /** Short grey text on the right of the row, e.g. a column's type. */
  readonly detail?: string;
  /** Longer text shown below the list for the selected item. */
  readonly documentation?: string;
  /**
   * Text that replaces the word being typed. Defaults to `label`.
   * `$0` marks where the caret ends up (e.g. `"COUNT($0)"`); otherwise it goes to the end.
   */
  readonly insertText?: string;
  /** Matched against what's typed instead of `label` (e.g. unquoted name for a `[quoted]` insert). */
  readonly filterText?: string;
  /** Tie-breaker among equally good matches; lower sorts first. Defaults to `label`. */
  readonly sortText?: string;
}

/** Where completions are being requested — handed to every provider. */
export interface CompletionContext {
  /** The editor's full text. */
  readonly text: string;
  /** Caret offset in `text`. */
  readonly offset: number;
  /** The partial word before the caret (may be ""). */
  readonly prefix: string;
  /** Offset where `prefix` starts — the start of the range an accepted item replaces. */
  readonly wordStart: number;
  /** Text from the start of the caret's line up to the caret. */
  readonly linePrefix: string;
  /** The character that opened the list (e.g. "."), if it was a trigger character. */
  readonly triggerCharacter?: string | undefined;
  /** True when the user asked explicitly (Ctrl+Space) rather than by typing. */
  readonly explicit: boolean;
}

export interface CompletionProvider {
  /** Characters (beyond word characters) that open the list, e.g. ["."]. */
  readonly triggerCharacters?: readonly string[];
  provideCompletions(context: CompletionContext): CompletionItem[] | Promise<CompletionItem[]>;
}
