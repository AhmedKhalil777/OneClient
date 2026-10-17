export interface ContainerRow {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string[];
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
