/**
 * Extending core's file editor (`oneclient.editors`).
 *
 * Any plugin can teach the file editor about a file type — or add actions to
 * every file — by contributing to the `oneclient.editors` extension point in
 * its manifest (`oneclient-files.editors`, its name from when the editor was a
 * plugin, still works):
 *
 *   "contributes": {
 *     "commands": [{ "id": "json.format", "title": "JSON: Format", "hidden": true }, …],
 *     "extensions": {
 *       "oneclient.editors": [{
 *         "id": "json", "label": "JSON", "extensions": ["json", "jsonc"],
 *         "format": "json.format", "symbols": "json.symbols", "tokens": "json.tokens"
 *       }]
 *     }
 *   }
 *
 * Each feature names a command *of the contributing plugin*; the editor calls
 * it with one of the request objects below and expects the matching result.
 * The command runs in the contributing plugin's own extension-host process, so
 * a slow or crashing language plugin can't take the editor down.
 *
 * Several plugins can contribute to the same file: for each single-valued
 * feature (format, symbols, tokens, preview) the most specific contribution
 * wins; `actions` from all matching contributions are combined.
 */

/** The extension point id; `oneclient.` points are owned by core. */
export const FILE_EDITORS_POINT = "oneclient.editors";
/** The same point under its old name (the editor used to be the Files plugin's); still read. */
export const LEGACY_FILE_EDITORS_POINT = "oneclient-files.editors";

export interface FileEditorAction {
  readonly id: string;
  /** Menu label, e.g. "Minify". */
  readonly label: string;
  /** Command taking a {@link TransformRequest} and returning a {@link TransformResult}. */
  readonly command: string;
  readonly title?: string;
}

/** One entry of `contributes.extensions["oneclient.editors"]`. */
export interface FileEditorContribution {
  readonly id: string;
  /** Language name shown in the editor's status bar ("JSON"). */
  readonly label: string;
  /** File extensions without the dot, lower-case; multi-part ones ("d.ts") are fine. `"*"` matches every file (lower priority than specific matches). */
  readonly extensions?: readonly string[];
  /** Exact file names, lower-case (".babelrc", "tsconfig.json"). Beat extensions. */
  readonly fileNames?: readonly string[];
  /** Command: {@link TransformRequest} → {@link TransformResult}. Bound to the Format button / Shift+Alt+F. */
  readonly format?: string;
  /** Command: {@link FileEditorRequest} → {@link SymbolsResult}. Drives the breadcrumb bar (path at the cursor). */
  readonly symbols?: string;
  /** Command: {@link FileEditorRequest} → {@link TokensResult}. Syntax highlighting. */
  readonly tokens?: string;
  /** Command: {@link FileEditorRequest} → {@link PreviewResult}. Enables the Preview pane. */
  readonly preview?: string;
  /** Open the preview pane automatically (e.g. Markdown). */
  readonly previewByDefault?: boolean;
  /** Extra transforms in the editor's Actions menu. */
  readonly actions?: readonly FileEditorAction[];
}

/** A contribution as delivered to views, tagged with the plugin that made it. */
export type ResolvedFileEditorContribution = FileEditorContribution & { readonly pluginId: string };

/** The merged feature set for one file. */
export interface FileEditorFeatures {
  /** Language label of the most specific matching contribution; undefined if only wildcard contributions matched. */
  readonly label?: string | undefined;
  readonly format?: string | undefined;
  readonly symbols?: string | undefined;
  readonly tokens?: string | undefined;
  readonly preview?: string | undefined;
  readonly previewByDefault: boolean;
  readonly actions: ReadonlyArray<FileEditorAction & { readonly pluginId: string }>;
}

/** How well a contribution matches a file name: 0 = no match; 3 file name, 2 extension (longer wins), 1 wildcard. */
function matchScore(c: FileEditorContribution, lowerName: string): number {
  if (c.fileNames?.some((n) => n.toLowerCase() === lowerName)) return 3;
  const parts = lowerName.split(".");
  let best = 0;
  for (const ext of c.extensions ?? []) {
    const e = ext.toLowerCase().replace(/^\./, "");
    if (e === "*") {
      best = Math.max(best, 1);
      continue;
    }
    for (let i = 1; i < parts.length; i++) {
      if (parts.slice(i).join(".") === e) best = Math.max(best, 2 + (parts.length - i) / 100);
    }
  }
  return best;
}

/**
 * Merges every contribution that matches `fileName` into one feature set:
 * specific matches outrank wildcard ones; each single-valued feature comes
 * from the best contribution that has it; actions are concatenated (best first).
 */
export function matchFileEditors(contributions: readonly ResolvedFileEditorContribution[], fileName: string): FileEditorFeatures {
  const lower = fileName.toLowerCase();
  const matches = contributions
    .map((c, index) => ({ c, index, score: matchScore(c, lower) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const first = <K extends "format" | "symbols" | "tokens" | "preview">(key: K): string | undefined =>
    matches.find((m) => m.c[key])?.c[key];

  const actions: Array<FileEditorAction & { pluginId: string }> = [];
  const seen = new Set<string>();
  for (const { c } of matches) {
    for (const a of c.actions ?? []) {
      const key = `${c.pluginId}:${a.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        actions.push({ ...a, pluginId: c.pluginId });
      }
    }
  }

  const specific = matches.find((m) => m.score >= 2);
  return {
    label: specific?.c.label,
    format: first("format"),
    symbols: first("symbols"),
    tokens: first("tokens"),
    preview: first("preview"),
    previewByDefault: matches.some((m) => m.c.previewByDefault && m.c.preview),
    actions,
  };
}

// ---- Requests & results ------------------------------------------------------------------------

/** What the editor sends every feature command. Text always uses "\n" line endings. */
export interface FileEditorRequest {
  readonly text: string;
  /** Base name, e.g. "tsconfig.json". */
  readonly fileName: string;
}

export interface TransformRequest extends FileEditorRequest {
  readonly tabSize: number;
  readonly insertSpaces: boolean;
  /** Current selection (offsets into `text`), if non-empty. Selection-aware actions limit themselves to it; others ignore it. */
  readonly selection?: { readonly start: number; readonly end: number };
}

export interface FileEditorError {
  readonly message: string;
  /** Offset into `text` the error points at; the editor jumps there on click. */
  readonly offset?: number;
}

/** Result of `format` and of actions: the new full document text, or why it couldn't be produced. */
export type TransformResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: FileEditorError };

export type DocumentSymbolKind =
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "property"
  | "element"
  | "heading"
  | "other";

/** A named, nested range of the document — shown as a breadcrumb segment while the cursor is inside it. */
export interface DocumentSymbol {
  readonly name: string;
  /** Dim text after the name (a value preview, an id attribute…). */
  readonly detail?: string;
  readonly kind: DocumentSymbolKind;
  /** Offsets into the request's `text`: [start, end). */
  readonly start: number;
  readonly end: number;
  readonly children?: readonly DocumentSymbol[];
}

export type SymbolsResult =
  | { readonly ok: true; readonly symbols: readonly DocumentSymbol[]; /** A syntax problem the editor shows in its status bar (symbols may be partial). */ readonly error?: FileEditorError }
  | { readonly ok: false; readonly error: FileEditorError };

/** Fixed vocabulary for syntax highlighting; the editor maps each class to a theme color. */
export type TokenClass =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "type"
  | "function"
  | "operator"
  | "variable"
  | "property"
  | "tag"
  | "attribute"
  | "punctuation"
  | "heading"
  | "strong"
  | "emphasis"
  | "link"
  | "code"
  | "quote"
  | "list";

/**
 * Tokens as flat numbers, three per token: `start, end, classIndex` (offsets into the request's
 * `text`, ascending and non-overlapping; `classIndex` indexes `classes`). Text between tokens keeps the default color.
 */
export type TokensResult =
  | { readonly ok: true; readonly tokens: readonly number[]; readonly classes: readonly TokenClass[] }
  | { readonly ok: false; readonly error: FileEditorError };

/** `html` is a body fragment (it is inserted into a sandboxed, script-less frame — but still escape untrusted input); `css` styles it and may use `var(--oc-*)` theme variables. */
export type PreviewResult =
  | { readonly ok: true; readonly html: string; readonly css?: string }
  | { readonly ok: false; readonly error: FileEditorError };
