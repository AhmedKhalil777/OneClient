/**
 * The child side of core's helper processes (extension hosts, the terminal host). They run either as an Electron
 * `utilityProcess` (the desktop app: `process.parentPort`) or as a plain Node `child_process.fork` (the web server:
 * `process.send` / `process.on("message")`). Both carry structured-clone messages (the server forks with
 * `serialization: "advanced"`), so callers see one API.
 */
export interface ParentPort {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
}

interface ElectronParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

export function parentPort(): ParentPort {
  const electronPort = (process as unknown as { parentPort?: ElectronParentPort }).parentPort;
  if (electronPort) {
    return {
      post: (message) => electronPort.postMessage(message),
      onMessage: (listener) => electronPort.on("message", (e) => listener(e.data)),
    };
  }
  if (!process.send) throw new Error("This process must be started by oneClient (no parent channel).");
  // The parent is gone (server stopped or crashed): don't linger as an orphan.
  process.on("disconnect", () => process.exit(0));
  return {
    post: (message) => {
      if (process.connected) process.send?.(message);
    },
    onMessage: (listener) => process.on("message", listener),
  };
}
