import type { TransformRequest, TransformResult } from "@oneclient/plugin-api";
import { detectCommand, parseCommand } from "./curl.js";
import { toHttpFileRequest } from "./httpfile.js";

/**
 * The editor's action "Convert cURL / PowerShell / fetch to HTTP request": the selection (or the whole document,
 * when nothing is selected) holds a command copied from the browser; it is replaced by the same request in `.http` syntax.
 */
export function convertCommandToHttpFile(r: TransformRequest): TransformResult {
  const start = r.selection?.start ?? 0;
  const end = r.selection?.end ?? r.text.length;
  const piece = r.text.slice(start, end);
  if (!detectCommand(piece)) {
    return { ok: false, error: { message: "Select a curl, PowerShell (Invoke-WebRequest) or fetch command copied from the browser, then run this action again." } };
  }
  let parsed;
  try {
    parsed = parseCommand(piece);
  } catch (err) {
    return { ok: false, error: { message: err instanceof Error ? err.message : String(err), offset: start } };
  }
  const q = parsed.request;
  const headers: Array<[string, string]> = q.headers.filter((h) => h.enabled && h.key).map((h) => [h.key, h.value]);
  let url = q.url;
  const has = (name: string) => headers.some(([k]) => k.toLowerCase() === name);
  switch (q.auth.type) {
    case "bearer":
      headers.unshift(["Authorization", `Bearer ${q.auth.token}`]);
      break;
    case "basic":
      headers.unshift(["Authorization", `Basic ${q.auth.username}:${q.auth.password}`]);
      break;
    case "apikey":
      if (q.auth.in === "header") headers.unshift([q.auth.key, q.auth.value]);
      else url += `${url.includes("?") ? "&" : "?"}${encodeURIComponent(q.auth.key)}=${encodeURIComponent(q.auth.value)}`;
      break;
    default:
      break;
  }
  let body = "";
  if (q.body.mode === "raw") body = q.body.raw;
  else if (q.body.mode === "urlencoded") {
    body = q.body.fields.filter((f) => f.enabled).map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join("&");
    if (!has("content-type")) headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
  } else if (q.body.mode === "formdata") {
    body = "# multipart/form-data bodies are not supported in .http files yet:\n" + q.body.fields.map((f) => `# ${f.key}=${f.value}`).join("\n");
  }
  let name = `${q.method} ${url}`;
  try {
    const u = new URL(url);
    name = `${q.method} ${u.pathname === "/" ? u.host : u.pathname}`;
  } catch {
    /* keep the raw name */
  }
  const text = toHttpFileRequest({ method: q.method, url, headers, body, name });
  const notes = parsed.notes.length ? `\n# Notes: ${parsed.notes.join(" ")}` : "";
  const before = r.text.slice(0, start);
  const prefix = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  return { ok: true, text: `${before}${prefix}${text}${notes}${r.text.slice(end)}` };
}
