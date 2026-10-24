import type { OutputLevel } from "@oneclient/plugin-api";

export type { OutputLevel };

/** One line in an Output channel. */
export interface OutputEntry {
  /** Unique within its channel, increasing. */
  id: number;
  /** Epoch ms. */
  time: number;
  level: OutputLevel;
  message: string;
  /** Optional extra text the panel shows when the entry is expanded. */
  detail?: string | undefined;
}

export interface OutputChannelInfo {
  /** `<pluginId>/<name>` — unique app-wide. */
  id: string;
  pluginId: string;
  name: string;
}

export interface OutputChannelState extends OutputChannelInfo {
  entries: OutputEntry[];
}
