import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ShellProfile {
  id: string;
  name: string;
  file: string;
  args: string[];
}

/** First existing path among candidates, or a bare command name to resolve via PATH. */
function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((c) => existsSync(c));
}

function onPath(exe: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  return undefined;
}

/**
 * Shells available on this machine, best default first — the same set VS
 * Code offers out of the box.
 */
export function detectProfiles(): ShellProfile[] {
  const profiles: ShellProfile[] = [];
  if (process.platform === "win32") {
    const sys = process.env.SystemRoot ?? "C:\\Windows";
    const pwsh = onPath("pwsh.exe") ?? firstExisting([join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe")]);
    if (pwsh) profiles.push({ id: "pwsh", name: "PowerShell", file: pwsh, args: ["-NoLogo"] });
    const winPs = join(sys, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(winPs)) profiles.push({ id: "powershell", name: pwsh ? "Windows PowerShell" : "PowerShell", file: winPs, args: ["-NoLogo"] });
    profiles.push({ id: "cmd", name: "Command Prompt", file: process.env.ComSpec ?? join(sys, "System32", "cmd.exe"), args: [] });
    const gitBash = firstExisting([
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
      join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
    ]);
    if (gitBash) profiles.push({ id: "gitbash", name: "Git Bash", file: gitBash, args: ["--login", "-i"] });
    const wsl = join(sys, "System32", "wsl.exe");
    if (existsSync(wsl)) profiles.push({ id: "wsl", name: "WSL", file: wsl, args: [] });
  } else {
    const userShell = process.env.SHELL;
    if (userShell) profiles.push({ id: "default", name: userShell.split("/").pop() ?? "shell", file: userShell, args: ["-l"] });
    for (const [id, file] of [
      ["zsh", "/bin/zsh"],
      ["bash", "/bin/bash"],
      ["fish", "/usr/bin/fish"],
      ["sh", "/bin/sh"],
    ] as const) {
      if (existsSync(file) && file !== userShell) profiles.push({ id, name: id, file, args: id === "sh" ? [] : ["-l"] });
    }
  }
  return profiles;
}
