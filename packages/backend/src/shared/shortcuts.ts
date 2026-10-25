import type { WorkbenchShortcut } from "./ipc-contract.js";

export interface KeyPress {
  key: string;
  code?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * Workbench shortcuts that must work while a Tier 2 view has focus — a focused view gets every key press. The desktop
 * app catches them in the view's `before-input-event`, the web shell in the iframe's keydown; both hand them to the shell.
 */
export function workbenchShortcut(input: KeyPress): WorkbenchShortcut | null {
  const mod = input.ctrl || input.meta;
  const key = input.key.toLowerCase();
  if (mod && !input.shift && !input.alt && (input.key === "`" || input.code === "Backquote")) return "togglePanel";
  if (mod && input.shift && key === "p") return "commandPalette";
  if (mod && !input.shift && !input.alt && key === "p") return "quickSearch";
  if (mod && input.shift && !input.alt && key === "f") return "findInFiles";
  if (mod && input.shift && !input.alt && key === "e") return "showExplorer";
  if (mod && input.shift && !input.alt && key === "g") return "showScm";
  if (mod && input.shift && !input.alt && key === "b") return "runBuildTask";
  if (mod && !input.shift && !input.alt && key === "b") return "toggleSidebar";
  if (mod && !input.shift && input.alt && key === "b") return "toggleSecondarySideBar";
  if (mod && !input.shift && !input.alt && key === "w") return "closeEditor";
  if (mod && !input.alt && input.key === "PageDown") return "nextEditor";
  if (mod && !input.alt && input.key === "PageUp") return "previousEditor";
  if (mod && !input.alt && (input.key === "=" || input.key === "+")) return "zoomIn";
  if (mod && !input.alt && input.key === "-") return "zoomOut";
  if (mod && !input.alt && input.key === "0") return "zoomReset";
  if (!mod && !input.alt && input.key === "F11") return "toggleFullScreen";
  return null;
}
