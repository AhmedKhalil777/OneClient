/**
 * @oneclient/editor-core — the editor's language core: dependency-free syntax tokenizers that produce the
 * `TokensResult` the file editor draws (see plugin-api/src/file-editor.ts). Plugins call these from their
 * `tokens` commands; adding a language here means adding one function and one `oneclient.editors` contribution.
 */
export { csharpTokens, cssTokens, javascriptTokens, typescriptTokens, yamlTokens } from "./languages.js";
export type { CodeLanguage } from "./languages.js";
export { tokenizeCFamily } from "./cfamily.js";
export type { CFamilyConfig } from "./cfamily.js";
export { tokenizeCss } from "./css.js";
export { tokenizeYaml } from "./yaml.js";
export { CLASSES, MAX_HIGHLIGHT_CHARS, TokenBuilder } from "./tokens.js";
