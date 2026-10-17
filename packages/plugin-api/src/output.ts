export type OutputLevel = "debug" | "info" | "warn" | "error";

/**
 * A named log stream shown in the app's bottom **Output** panel, where the user picks which channel to read
 * (like VS Code's Output view). Create one with `PluginContext.createOutputChannel` — e.g. a plugin logs the
 * requests it sends, the commands it runs, or a long task's progress. Entries are kept in memory (the most
 * recent ~2000 per channel) and never persisted; don't log secrets.
 */
export interface OutputChannel {
  /** The channel's display name (shown under the plugin's name in the picker). */
  readonly name: string;
  /** `detail` is optional extra text (a request body, a stack trace) the user can expand. */
  log(level: OutputLevel, message: string, detail?: string): void;
  debug(message: string, detail?: string): void;
  info(message: string, detail?: string): void;
  warn(message: string, detail?: string): void;
  error(message: string, detail?: string): void;
  /** Shorthand for `info` — one line of output. */
  appendLine(message: string): void;
  /** Empties the channel. */
  clear(): void;
  /** Opens the Output panel on this channel. */
  show(): void;
}
