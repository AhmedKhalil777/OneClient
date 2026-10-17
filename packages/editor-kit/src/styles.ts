/**
 * Popup styles, injected once per document. Themeable through CSS custom
 * properties — a plugin can override any `--oc-ac-*` variable on :root.
 * Defaults match oneClient's dark theme (VS Code Dark+).
 */
const CSS = `
:root {
  /* Follow the active oneClient theme (core injects --oc-* into every view). */
  --oc-ac-bg: var(--oc-widget-background, #252526);
  --oc-ac-border: var(--oc-menu-border, #454545);
  --oc-ac-fg: var(--oc-foreground, #cccccc);
  --oc-ac-dim: var(--oc-descriptionForeground, #8b8b8b);
  --oc-ac-selected-bg: var(--oc-list-activeSelectionBackground, #04395e);
  --oc-ac-selected-fg: var(--oc-list-activeSelectionForeground, #ffffff);
  --oc-ac-match: var(--oc-list-highlightForeground, #2aaaff);
  --oc-ac-font: -apple-system, "Segoe UI", system-ui, sans-serif;
  --oc-ac-font-size: 13px;
}
.oc-ac {
  position: fixed;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  min-width: 260px;
  max-width: 520px;
  background: var(--oc-ac-bg);
  color: var(--oc-ac-fg);
  border: 1px solid var(--oc-ac-border);
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  font-family: var(--oc-ac-font);
  font-size: var(--oc-ac-font-size);
  overflow: hidden;
}
.oc-ac-list {
  max-height: 264px;
  overflow-y: auto;
}
.oc-ac-item {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px 0 4px;
  white-space: nowrap;
  cursor: pointer;
}
.oc-ac-item.selected {
  background: var(--oc-ac-selected-bg);
  color: var(--oc-ac-selected-fg);
}
.oc-ac-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.oc-ac-label b {
  color: var(--oc-ac-match);
  font-weight: 600;
}
.oc-ac-detail {
  margin-left: auto;
  padding-left: 16px;
  color: var(--oc-ac-dim);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.oc-ac-item.selected .oc-ac-detail {
  color: #c5d6e6;
}
.oc-ac-kind {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  font: 600 10px/16px var(--oc-ac-font);
  text-align: center;
  color: #1e1e1e;
}
.oc-ac-doc {
  padding: 6px 10px;
  border-top: 1px solid var(--oc-ac-border);
  color: var(--oc-ac-dim);
  font-size: 12px;
  white-space: pre-wrap;
  max-height: 96px;
  overflow-y: auto;
}
`;

let injected = false;

export function ensureStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.dataset.oneclient = "autocomplete";
  style.textContent = CSS;
  document.head.prepend(style); // first, so plugin styles can override
}

/** Letter + colour badge per kind (VS Code-ish palette). */
export const KIND_BADGE: Record<string, { letter: string; color: string }> = {
  keyword: { letter: "K", color: "#569cd6" },
  function: { letter: "ƒ", color: "#dcdcaa" },
  method: { letter: "m", color: "#dcdcaa" },
  variable: { letter: "v", color: "#9cdcfe" },
  constant: { letter: "c", color: "#4fc1ff" },
  type: { letter: "T", color: "#4ec9b0" },
  snippet: { letter: "S", color: "#c586c0" },
  text: { letter: "a", color: "#9d9d9d" },
  file: { letter: "F", color: "#c5c5c5" },
  folder: { letter: "D", color: "#dcb67a" },
  database: { letter: "D", color: "#d7ba7d" },
  schema: { letter: "S", color: "#c09a4f" },
  table: { letter: "T", color: "#75beff" },
  view: { letter: "V", color: "#b180d7" },
  column: { letter: "c", color: "#9da5b4" },
  procedure: { letter: "P", color: "#e8a33d" },
  field: { letter: "f", color: "#75beff" },
  property: { letter: "p", color: "#9cdcfe" },
  module: { letter: "M", color: "#c5c5c5" },
};
