import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHttpFile, httpFileLenses, httpFileSymbols, httpFileTokens, TOKEN_CLASSES } from "../src/httpfile.js";
import { jsonPath, resetSession, runHttpFileRequest } from "../src/httpfile-run.js";

const FILE = [
  "@host = http://HOST",
  "@token = abc",
  "",
  "### Log in",
  "# @name login",
  "POST {{host}}/login HTTP/1.1",
  "Content-Type: application/json",
  "",
  '{ "user": "ann", "n": 3 }',
  "",
  "### Who am I",
  "GET {{host}}/me",
  "  ?verbose=1",
  "  &x=2",
  "Authorization: Bearer {{login.response.body.$.token}}",
  "",
  "### Bare URL",
  "{{host}}/plain",
].join("\n");

describe("parsing", () => {
  it("finds variables, named requests, headers, bodies and line numbers", () => {
    const p = parseHttpFile(FILE);
    expect(p.variables.map((v) => [v.name, v.value])).toEqual([["host", "http://HOST"], ["token", "abc"]]);
    expect(p.requests.map((r) => [r.method, r.name])).toEqual([["POST", "login"], ["GET", undefined], ["GET", undefined]]);
    const [login, me, bare] = p.requests;
    expect(login).toMatchObject({ line: 5, url: "{{host}}/login", body: '{ "user": "ann", "n": 3 }', headers: [["Content-Type", "application/json"]] });
    expect(me).toMatchObject({ url: "{{host}}/me?verbose=1&x=2", headers: [["Authorization", "Bearer {{login.response.body.$.token}}"]] });
    expect(bare).toMatchObject({ url: "{{host}}/plain", body: "" });
  });

  it("gives every request a lens on its own line, and an outline entry", () => {
    const lenses = httpFileLenses(FILE);
    expect(lenses.ok && lenses.lenses.map((l) => l.line)).toEqual([5, 11, 17]);
    expect(lenses.ok && lenses.lenses[0]!.title).toContain("(login)");
    const sym = httpFileSymbols(FILE);
    expect(sym.ok && sym.symbols.map((s) => s.name)).toEqual(["login", "GET {{host}}/me?verbose=1&x=2", "GET {{host}}/plain"]);
  });

  it("produces ascending, non-overlapping tokens that color methods, headers and {{variables}}", () => {
    const r = httpFileTokens(FILE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const seen: string[] = [];
    let last = 0;
    for (let i = 0; i < r.tokens.length; i += 3) {
      expect(r.tokens[i]!).toBeGreaterThanOrEqual(last);
      last = r.tokens[i + 1]!;
      seen.push(`${TOKEN_CLASSES[r.tokens[i + 2]!]}:${FILE.slice(r.tokens[i], r.tokens[i + 1])}`);
    }
    expect(seen).toContain("keyword:POST");
    expect(seen).toContain("property:Content-Type");
    expect(seen).toContain("variable:{{host}}");
    expect(seen).toContain("comment:### Log in");
    expect(seen).toContain("property:\"user\"");
  });

  it("never throws on odd input", () => {
    for (const s of ["", "###", "GET", "@x", "# @name", "POST\n\n\n{", "\n\n###\n###\n"]) expect(() => parseHttpFile(s)).not.toThrow();
  });
});

describe("jsonPath", () => {
  it("reads nested keys, indexes and quoted keys", () => {
    const v = { a: { b: [{ id: 7 }] }, "x-y": 1 };
    expect(jsonPath(v, "$.a.b[0].id")).toBe(7);
    expect(jsonPath(v, "$['x-y']")).toBe(1);
    expect(jsonPath(v, "$.nope.deep")).toBeUndefined();
    expect(jsonPath(v, "$")).toBe(v);
  });
});

describe("sending", () => {
  let server: Server;
  let host = "";
  const seen: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        if (req.url === "/login") {
          res.setHeader("content-type", "application/json");
          res.setHeader("x-request-id", "r1");
          return res.end(JSON.stringify({ token: "T0KEN", user: { id: 9 } }));
        }
        if (req.url?.startsWith("/me")) return res.end("hello <b>you</b>");
        res.statusCode = 404;
        res.end("nope");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("sends a request with its headers and body, and shows the status, JSON and headers", async () => {
    resetSession();
    seen.length = 0;
    const r = await runHttpFileRequest(FILE.replace("HOST", host), "t.http", 0);
    expect(r.ok && r.html).toContain("200 OK");
    expect(r.ok && r.html).toContain('<span class="k">&quot;token&quot;</span>');
    expect(r.ok && r.html).toContain("x-request-id");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/login", body: '{ "user": "ann", "n": 3 }' });
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
  });

  it("chains: a later request uses the named request's response, sending it first when needed", async () => {
    resetSession();
    seen.length = 0;
    const r = await runHttpFileRequest(FILE.replace("HOST", host), "chain.http", 1);
    expect(seen.map((s) => s.url)).toEqual(["/login", "/me?verbose=1&x=2"]);
    expect(seen[1]!.headers.authorization).toBe("Bearer T0KEN");
    expect(r.ok && r.html).toContain("hello &lt;b&gt;you&lt;/b&gt;"); // response text is escaped
    // second run reuses the cached login
    seen.length = 0;
    await runHttpFileRequest(FILE.replace("HOST", host), "chain.http", 1);
    expect(seen.map((s) => s.url)).toEqual(["/me?verbose=1&x=2"]);
  });

  it("explains problems instead of throwing: unknown request, no host, refused connection, undefined variables", async () => {
    resetSession();
    expect((await runHttpFileRequest("GET http://x", "a.http", 4)).ok && "no longer").toBeTruthy();
    const noHost = await runHttpFileRequest("GET /api", "b.http", 0);
    expect(noHost.ok && noHost.html).toContain("has no host");
    const refused = await runHttpFileRequest("GET http://127.0.0.1:1/x", "c.http", 0);
    expect(refused.ok && refused.html).toContain("err-box");
    const missing = await runHttpFileRequest(`GET http://${host}/x/{{nope}}`, "d.http", 0);
    expect(missing.ok && missing.html).toContain("{{nope}}");
    expect(missing.ok && missing.html).toContain("404");
  });

  it("converts 'Basic user:pass' and fills dynamic values", async () => {
    resetSession();
    seen.length = 0;
    await runHttpFileRequest(`GET http://${host}/me\nAuthorization: Basic ann:secret\nX-Id: {{$guid}}\nX-N: {{$randomInt 5 5}}`, "e.http", 0);
    expect(seen[0]!.headers.authorization).toBe(`Basic ${Buffer.from("ann:secret").toString("base64")}`);
    expect(seen[0]!.headers["x-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[0]!.headers["x-n"]).toBe("5");
  });
});
