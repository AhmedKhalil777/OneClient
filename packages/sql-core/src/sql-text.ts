/**
 * A script as one short line: leading comments and blank lines dropped, all whitespace collapsed, cut to `max`
 * characters ("SELECT * FROM orders WHERE …"). Used for task titles and history labels.
 */
export function summarize(sql: string, max: number): string {
  const lines = sql.split(/\r?\n/);
  const start = lines.findIndex((l) => {
    const t = l.trim();
    return t && !t.startsWith("--") && !t.startsWith("#") && !t.startsWith("/*");
  });
  const one = (start < 0 ? sql : lines.slice(start).join(" ")).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
