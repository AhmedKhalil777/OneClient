import type { FileEditorAction, ResolvedFileEditorContribution } from "@oneclient/plugin-api";

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * Contributions arrive as untyped manifest data from other plugins. Keep only well-formed ones and
 * only the fields we understand — a typo in someone's manifest must not break the editor.
 */
export function sanitizeContributions(raw: ReadonlyArray<Record<string, unknown>>): ResolvedFileEditorContribution[] {
  const out: ResolvedFileEditorContribution[] = [];
  for (const item of raw) {
    const id = str(item.id);
    const label = str(item.label);
    const pluginId = str(item.pluginId);
    if (!id || !label || !pluginId) continue;
    const actions: FileEditorAction[] = [];
    if (Array.isArray(item.actions)) {
      for (const a of item.actions as Array<Record<string, unknown>>) {
        const aid = str(a?.id);
        const alabel = str(a?.label);
        const command = str(a?.command);
        if (aid && alabel && command) actions.push({ id: aid, label: alabel, command, ...(str(a.title) ? { title: str(a.title)! } : {}) });
      }
    }
    const extensions = strings(item.extensions);
    const fileNames = strings(item.fileNames);
    const format = str(item.format);
    const symbols = str(item.symbols);
    const tokens = str(item.tokens);
    const preview = str(item.preview);
    out.push({
      id,
      label,
      pluginId,
      ...(extensions ? { extensions } : {}),
      ...(fileNames ? { fileNames } : {}),
      ...(format ? { format } : {}),
      ...(symbols ? { symbols } : {}),
      ...(tokens ? { tokens } : {}),
      ...(preview ? { preview } : {}),
      ...(item.previewByDefault === true ? { previewByDefault: true } : {}),
      ...(actions.length ? { actions } : {}),
    });
  }
  return out;
}
