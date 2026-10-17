/**
 * `@oneclient/editor-kit/editor` — the feature-aware code editor.
 *
 *   import { FeatureEditor } from "@oneclient/editor-kit/editor";
 *   import "@oneclient/editor-kit/editor.css";
 *
 * Its language smarts (format, breadcrumbs, highlighting, preview, actions) come from other plugins through the
 * `oneclient-files.editors` extension point — see plugin-api/src/file-editor.ts.
 */
export { FeatureEditor, detectIndent, type FeatureEditorProps } from "./editor/FeatureEditor.js";
export { FEATURE_TEXT_LIMIT, callFeature } from "./editor/features.js";
export { caretAfterReplace, diffEdit, lineOf, mapBack, mapForward, shiftTokens, type TextEdit } from "./editor/edit.js";
export { buildHighlightHtml } from "./editor/highlight.js";
export { symbolPath, siblingsAt } from "./editor/symbols.js";
export { sanitizeContributions } from "./editor/contributions.js";
