/** `KEY=VALUE` lines ⇄ a record (environment, variables). */
export const parseKv = (text: string, sep = "="): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + sep.length).trim();
  }
  return out;
};
export const formatKv = (rec: Record<string, string> | undefined, sep = "="): string => Object.entries(rec ?? {}).map(([k, v]) => `${k}${sep}${v}`).join("\n");

/** Extractions as lines: `id = json:data.id`, `etag = header:ETag`, `code = status`, `raw = body`. */
export function parseExtract(text: string): Array<{ name: string; from: "json" | "header" | "status" | "body"; path?: string }> {
  const out: Array<{ name: string; from: "json" | "header" | "status" | "body"; path?: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^=\s]+)\s*=\s*(json|header|status|body)(?::\s*(.*?))?\s*$/.exec(line);
    if (m) out.push({ name: m[1]!, from: m[2] as "json", ...(m[3] ? { path: m[3] } : {}) });
  }
  return out;
}
export const formatExtract = (list: Array<{ name: string; from: string; path?: string }> | undefined): string =>
  (list ?? []).map((e) => `${e.name} = ${e.from}${e.path ? `:${e.path}` : ""}`).join("\n");
