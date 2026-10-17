/**
 * Logger handed to plugins via `PluginContext.logger`. Implementations
 * (provided by core) forward to the structured app log and tag every
 * entry with the originating plugin id — plugins never write to stdout
 * directly, since the extension host's stdout/stderr are already piped
 * to the main process for crash diagnostics.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
