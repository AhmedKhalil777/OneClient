import { describe, expect, it } from "vitest";
import { detectCommand, parseCommand } from "../src/curl.js";

/** What each browser's "Copy as …" menu actually puts on the clipboard (names and values changed). */
const CHROME_BASH = `curl 'https://api.example.com/v1/items?x=1' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'accept-language: en-US,en;q=0.9' \\
  -H 'authorization: Bearer abc.def' \\
  -H 'content-type: application/json' \\
  -b 'sid=123; theme=dark' \\
  -H 'user-agent: Mozilla/5.0 Test' \\
  --data-raw '{"name":"A","tags":["x","y"]}' \\
  --compressed`;

const CHROME_CMD = `curl "https://api.example.com/v1/items" ^
  -H "accept: application/json" ^
  -H "content-type: application/json" ^
  -H "cookie: sid=123" ^
  --data-raw ^"^{^\\^"name^\\^":^\\^"A^\\^",^\\^"n^\\^":2^}^"`;

const CHROME_POWERSHELL = [
  "$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession",
  '$session.UserAgent = "Mozilla/5.0 Test"',
  '$session.Cookies.Add((New-Object System.Net.Cookie("sid", "123", "/", "api.example.com")))',
  '$session.Cookies.Add((New-Object System.Net.Cookie("theme", "dark", "/", "api.example.com")))',
  'Invoke-WebRequest -UseBasicParsing -Uri "https://api.example.com/v1/items" `',
  '-Method "POST" `',
  "-WebSession $session `",
  "-Headers @{",
  '"accept"="application/json"',
  '"authorization"="Bearer abc"',
  '"x-note"="it`"s fine"',
  "} `",
  '-ContentType "application/json" `',
  '-Body "{`"name`":`"A`",`"n`":2}"',
].join("\n");

const CHROME_FETCH = `fetch("https://api.example.com/v1/items", {
  "headers": {
    "accept": "application/json",
    "content-type": "application/json",
    "x-api-key": "k"
  },
  "referrer": "https://app.example.com/",
  "referrerPolicy": "strict-origin-when-cross-origin",
  "body": "{\\"name\\":\\"A\\",\\"n\\":2}",
  "method": "POST",
  "mode": "cors",
  "credentials": "include"
});`;

const header = (r: { request: { headers: Array<{ key: string; value: string }> } }, name: string) => r.request.headers.find((h) => h.key.toLowerCase() === name)?.value;

describe("pasted browser commands", () => {
  it("detects each flavour and ignores everything else", () => {
    expect(detectCommand(CHROME_BASH)).toBe("curl");
    expect(detectCommand(CHROME_CMD)).toBe("curl");
    expect(detectCommand("curl.exe -s https://x")).toBe("curl");
    expect(detectCommand("$ curl https://x")).toBe("curl");
    expect(detectCommand(CHROME_POWERSHELL)).toBe("powershell");
    expect(detectCommand("irm https://x.test")).toBe("powershell");
    expect(detectCommand(CHROME_FETCH)).toBe("fetch");
    expect(detectCommand("await fetch('https://x')")).toBe("fetch");
    for (const no of ["hello", '{"a":1}', "https://example.com", "curling is fun", "fetchMe(1)", ""]) expect(detectCommand(no), no).toBeUndefined();
  });

  it("Copy as cURL (bash)", () => {
    const r = parseCommand(CHROME_BASH);
    expect(r.flavor).toBe("curl");
    expect(r.request).toMatchObject({ method: "POST", url: "https://api.example.com/v1/items?x=1", auth: { type: "bearer", token: "abc.def" }, body: { mode: "raw", language: "json", raw: '{"name":"A","tags":["x","y"]}' } });
    expect(header(r, "cookie")).toBe("sid=123; theme=dark");
    expect(header(r, "accept")).toBe("application/json, text/plain, */*");
  });

  it("Copy as cURL (cmd) — the ^ escapes are undone", () => {
    const r = parseCommand(CHROME_CMD);
    expect(r.request.url).toBe("https://api.example.com/v1/items");
    expect(r.request.method).toBe("POST");
    expect(r.request.body).toMatchObject({ mode: "raw", raw: '{"name":"A","n":2}' });
    expect(header(r, "cookie")).toBe("sid=123");
  });

  it("Copy as PowerShell — session cookies, headers table, content type and body", () => {
    const r = parseCommand(CHROME_POWERSHELL);
    expect(r.flavor).toBe("powershell");
    expect(r.request).toMatchObject({ method: "POST", url: "https://api.example.com/v1/items", auth: { type: "bearer", token: "abc" }, body: { mode: "raw", language: "json", raw: '{"name":"A","n":2}' } });
    expect(header(r, "user-agent")).toBe("Mozilla/5.0 Test");
    expect(header(r, "cookie")).toBe("sid=123; theme=dark");
    expect(header(r, "x-note")).toBe('it"s fine');
    expect(r.notes).toEqual([]);
  });

  it("PowerShell by hand: aliases, positional URL, single quotes, and bodies it cannot evaluate", () => {
    expect(parseCommand("iwr https://x.test/a -Method Delete").request).toMatchObject({ method: "DELETE", url: "https://x.test/a" });
    const r = parseCommand("Invoke-RestMethod -Uri 'https://x.test/it''s' -Method Post -Body $payload -Headers @{ 'A' = 'b'; 'C' = 'd' }");
    expect(r.request.url).toBe("https://x.test/it's");
    expect(r.request.headers.map((h) => [h.key, h.value])).toEqual([["A", "b"], ["C", "d"]]);
    expect(r.notes.join(" ")).toContain("-Body used a PowerShell variable");
  });

  it("Copy as fetch", () => {
    const r = parseCommand(CHROME_FETCH);
    expect(r.flavor).toBe("fetch");
    expect(r.request).toMatchObject({ method: "POST", url: "https://api.example.com/v1/items", body: { mode: "raw", language: "json", raw: '{"name":"A","n":2}' } });
    expect(header(r, "x-api-key")).toBe("k");
    expect(parseCommand(`fetch("https://x.test/p")`).request).toMatchObject({ method: "GET", url: "https://x.test/p" });
    expect(parseCommand(`await fetch('https://x.test/p', { method: 'put', headers: { 'X-A': '1' } })`).request).toMatchObject({ method: "PUT", url: "https://x.test/p" });
  });

  it("explains what it cannot read", () => {
    expect(() => parseCommand("hello world")).toThrow(/not a curl/);
    expect(() => parseCommand("Invoke-WebRequest -Method Get")).toThrow(/No URL/);
    expect(() => parseCommand("fetch(")).toThrow(/URL/);
  });
});

describe("convert to .http syntax", () => {
  it("replaces the selected command with a request in .http syntax, runnable by the file engine", async () => {
    const { convertCommandToHttpFile } = await import("../src/httpfile-convert.js");
    const { parseHttpFile } = await import("../src/httpfile.js");
    const text = `@host = x\n\n${CHROME_BASH}\n\n### later\nGET http://h/z`;
    const start = text.indexOf("curl");
    const end = start + CHROME_BASH.length;
    const r = convertCommandToHttpFile({ text, fileName: "a.http", tabSize: 2, insertSpaces: true, selection: { start, end } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = parseHttpFile(r.text);
    expect(parsed.requests).toHaveLength(2);
    expect(parsed.requests[0]).toMatchObject({ method: "POST", url: "https://api.example.com/v1/items?x=1", body: '{"name":"A","tags":["x","y"]}' });
    expect(parsed.requests[0]!.headers.find(([k]) => k === "Authorization")?.[1]).toBe("Bearer abc.def");
    expect(r.text).toContain("### POST /v1/items");
    expect(r.text.endsWith("GET http://h/z")).toBe(true);
  });

  it("converts the whole document when nothing is selected, and explains when it is not a command", async () => {
    const { convertCommandToHttpFile } = await import("../src/httpfile-convert.js");
    const whole = convertCommandToHttpFile({ text: CHROME_FETCH, fileName: "a.http", tabSize: 2, insertSpaces: true });
    expect(whole.ok && whole.text.startsWith("### POST /v1/items\nPOST https://api.example.com/v1/items")).toBe(true);
    const no = convertCommandToHttpFile({ text: "hello", fileName: "a.http", tabSize: 2, insertSpaces: true });
    expect(no.ok).toBe(false);
  });
});
