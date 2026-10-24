export interface ContainerRow {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string[];
  /** The plugin whose template the container matches, and the saved connections pointing at it. */
  plugin: { pluginId: string; product: string; icon: string; connections: Array<{ id: string; name: string }> } | null;
}

/** A container template with defaults for this Docker host (docker.listTemplates). */
export interface TemplateItem {
  key: string;
  pluginId: string;
  title: string;
  product: string;
  description: string;
  icon: string;
  image: string;
  typeId: string;
  ports: Array<{ container: string; label: string; host: number }>;
  variables: Array<{ name: string; label: string; description: string; secret: boolean; value: string }>;
  name: string;
  connectionName: string;
  /** Containers already running this template's image. */
  existing: Array<{ id: string; name: string; state: string }>;
}

export interface RunResult extends CommandResult {
  message?: string;
  containerId?: string;
  connectionId?: string;
}

export interface ImageRow {
  id: string;
  tag: string;
  size: number;
  created: number;
}

export interface CommandResult {
  ok: boolean;
  error?: string;
}

export const connectionId = new URLSearchParams(location.search).get("connectionId") ?? "";

async function invoke<T>(commandId: string, args: Record<string, unknown>): Promise<T> {
  return window.oneclientView.invokeCommand(commandId, [{ connectionId, ...args }]) as Promise<T>;
}

export const listContainers = () => invoke<ContainerRow[]>("docker.listContainers", {});
export const listImages = () => invoke<ImageRow[]>("docker.listImages", {});
export const startContainer = (containerId: string) => invoke<CommandResult>("docker.startContainer", { containerId });
export const stopContainer = (containerId: string) => invoke<CommandResult>("docker.stopContainer", { containerId });
export const restartContainer = (containerId: string) => invoke<CommandResult>("docker.restartContainer", { containerId });
export const removeContainer = (containerId: string) => invoke<CommandResult>("docker.removeContainer", { containerId });
export const pullImage = (image: string) => invoke<CommandResult>("docker.pullImage", { image });
export const listTemplates = () => invoke<TemplateItem[]>("docker.listTemplates", {});
export const runTemplate = (args: { template: string; name: string; ports: Record<string, number>; variables: Record<string, string>; connectionName: string }) =>
  invoke<RunResult>("docker.runTemplate", args);
export const connectContainer = (containerId: string) => invoke<RunResult>("docker.connectContainer", { containerId });

/** Tab and template the view was opened for (a Templates node passes them). */
export const initialParams = {
  tab: new URLSearchParams(location.search).get("tab"),
  template: new URLSearchParams(location.search).get("template"),
};

export type LogEvent =
  | { type: "logLine"; containerId: string; text: string }
  | { type: "logError"; containerId: string; error: string }
  | { type: "logEnd"; containerId: string };

export function tailLogs(containerId: string, onEvent: (event: LogEvent) => void): () => void {
  const off = window.oneclientView.onMessage((message) => onEvent(message as LogEvent));
  window.oneclientView.postMessage({ type: "tailLogs", containerId });
  return () => {
    window.oneclientView.postMessage({ type: "stopTailLogs" });
    off();
  };
}
