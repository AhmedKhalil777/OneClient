export { PLUGIN_API_VERSION } from "./version.js";

export type { JsonSchemaObject, JsonSchemaType, UiSchema } from "./json-schema.js";
export type { Logger } from "./logging.js";
export type { SecretStore } from "./secrets.js";

export type {
  ConnectionContext,
  ConnectionHandle,
  ConnectionProvider,
  ConnectionTestResult,
} from "./connection.js";

export type { ExplorerContext, ExplorerProvider, TreeNode, TreeNodeOpenView } from "./explorer.js";
export type { CompletionContext, CompletionItem, CompletionItemKind, CompletionProvider } from "./completion.js";
export type {
  DocumentSymbol,
  DocumentSymbolKind,
  FileEditorAction,
  FileEditorContribution,
  FileEditorError,
  FileEditorFeatures,
  FileEditorRequest,
  PreviewResult,
  ResolvedFileEditorContribution,
  SymbolsResult,
  TokenClass,
  TokensResult,
  TransformRequest,
  TransformResult,
} from "./file-editor.js";
export { FILE_EDITORS_POINT, matchFileEditors } from "./file-editor.js";
export type {
  ColorThemeContribution,
  FileIconAssociations,
  FileIconMappings,
  IconContribution,
  IconThemeContribution,
  IconThemeFile,
  ThemeColorKey,
  ThemeKind,
  ThemeState,
} from "./theme.js";
export { THEME_COLOR_KEYS, colorVarName, iconUrl, normalizeFolderName, parseIconRef, resolveFileIcon } from "./theme.js";

export type { CommandContext, CommandHandler } from "./commands.js";

export type {
  ColumnDescriptor,
  ColumnValueType,
  TableResult,
  ViewHostApi,
  ViewMessageContext,
  ViewMessageHandler,
} from "./ui.js";

export type {
  CommandContribution,
  ConnectionTypeContribution,
  ExplorerNodeContribution,
  PluginManifest,
  ViewContribution,
} from "./manifest.js";

export type {
  Disposable,
  PluginActivate,
  PluginContext,
  PluginDeactivate,
  PluginModule,
} from "./context.js";
