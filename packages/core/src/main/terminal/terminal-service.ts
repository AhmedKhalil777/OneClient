import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type UtilityProcess, utilityProcess } from "electron";
import type { TerminalHostInbound, TerminalHostOutbound } from "../../terminal-host/host.js";

/** The Terminal panel view (a core view in the bottom panel). */
export const TERMINAL_VIEW = "terminal.panel";

/**
 * Core's integrated terminal: owns the terminal host process (out/main/terminal-host.js, started on first use and
 * again after a crash), relays the panel view's messages to it, and runs the Terminal menu's commands.
 */
export class TerminalService {
  private host: UtilityProcess | null = null;
  private readonly pending = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();

  constructor(
    /** Push a message to the Terminal panel view. */
    private readonly pushToView: (message: unknown) => void,
    /** Where new terminals start: the first workspace folder, else the home folder. */
    private readonly defaultCwd: () => string | undefined,
    private readonly entry = join(__dirname, "terminal-host.js"),
  ) {}

  private ensure(): UtilityProcess {
    if (this.host) return this.host;
    const host = utilityProcess.fork(this.entry, [], { serviceName: "oneclient-terminal", stdio: "pipe" });
    host.on("message", (msg: TerminalHostOutbound) => {
      if (msg.type === "push") this.pushToView(msg.message);
      else {
        const p = this.pending.get(msg.requestId);
        this.pending.delete(msg.requestId);
        if (msg.ok) p?.resolve();
        else p?.reject(new Error(msg.error));
      }
    });
    host.on("exit", (code) => {
      this.host = null;
      for (const p of this.pending.values()) p.reject(new Error(`The terminal process exited (code ${code}).`));
      this.pending.clear();
      // An open panel shows the shells are gone and can start a new one.
      this.pushToView({ type: "state", profiles: [], sessions: [], crashed: code !== 0 });
    });
    this.host = host;
    return host;
  }

  private send(message: TerminalHostInbound): void {
    this.ensure().postMessage(message);
  }

  /** A message from the panel view (hello / create / input / resize / kill). */
  fromView(message: unknown): void {
    this.send({ type: "view", message: message as never });
  }

  /** The panel view was closed (window reload); shells keep running. */
  viewGone(): void {
    if (this.host) this.send({ type: "viewGone" });
  }

  private command(command: "new" | "kill" | "clear", cwd?: string): Promise<void> {
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.send({ type: "command", requestId, command, ...(cwd ? { cwd } : {}) });
    });
  }

  /** Terminal commands, by id (the menu, "Open in Terminal" on Explorer entries). They reveal the panel. */
  commands(): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
    const run = async (fn: () => Promise<void>) => {
      try {
        await fn();
        return { ok: true, revealView: TERMINAL_VIEW };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };
    return {
      "terminal.new": () => run(() => this.command("new", this.defaultCwd())),
      // Explorer context menu: node data carries the entry's absolute path (a file opens in its folder).
      "terminal.openAt": (a) => run(() => this.command("new", typeof a.fsPath === "string" ? a.fsPath : this.defaultCwd())),
      "terminal.kill": () => run(() => this.command("kill")),
      "terminal.clear": () => run(() => this.command("clear")),
    };
  }

  dispose(): void {
    if (this.host) this.send({ type: "shutdown" });
  }
}
