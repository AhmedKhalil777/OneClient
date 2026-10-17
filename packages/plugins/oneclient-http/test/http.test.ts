import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callApi } from "../src/api.js";
import { parseCurl, toCurl, tokenize } from "../src/curl.js";
import type { RequestDef } from "../src/model.js";
import { exportCollection, importCollection, importEnvironment, isPostmanCollection, isPostmanEnvironment } from "../src/postman.js";
import { prepare, send } from "../src/runner.js";
import { migrateWorkspace } from "../src/store.js";
import { buildScope, interpolate } from "../src/vars.js";

const def = (over: Partial<RequestDef> = {}): RequestDef => ({ method: "GET", url: "", headers: [], body: { mode: "none" }, auth: { type: "none" }, ...over });

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/redirect") {
        res.writeHead(302, { Location: "/echo?redirected=1" });
        res.end();
      } else if (url.pathname === "/gzip") {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
        res.end(zlib.gzipSync(JSON.stringify({ zipped: true })));
      } else if (url.pathname === "/cookie") {
        res.writeHead(200, { "Set-Cookie": ["a=1; Path=/", "b=2"], "Content-Type": "text/plain" });
        res.end("ok");
      } else if (url.pathname === "/bin") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const opts = { timeoutMs: 5000, followRedirects: true, allowSelfSigned: false };
const run = async (d: RequestDef, vars: Record<string, string> = {}) => {
  const scope = new Map(Object.entries(vars));
  return send(prepare(d, scope, d.auth), opts);
};

describe("variables", () => {
  it("replaces {{name}} and dynamic values, and reports unknown ones", () => {
    const r = interpolate("{{host}}/{{ id }}/{{$guid}}/{{missing}}", new Map([["host", "h"], ["id", "7"]]));
    expect(r.text).toMatch(/^h\/7\/[0-9a-f-]{36}\/\{\{missing\}\}$/);
    expect(r.unresolved).toEqual(["missing"]);
  });

  it("lets the environment override collection variables, ignoring disabled ones", () => {
    const ws = {
      version: 1,
      history: [],
      activeEnvironmentId: "e",
      environments: [{ id: "e", name: "dev", variables: [{ key: "a", value: "env", enabled: true }, { key: "off", value: "x", enabled: false }] }],
      collections: [],
    };
    const col = { id: "c", name: "c", auth: { type: "none" as const }, items: [], variables: [{ key: "a", value: "col", enabled: true }, { key: "b", value: "col", enabled: true }] };
    const scope = buildScope(ws, col);
    expect(scope.get("a")).toBe("env");
    expect(scope.get("b")).toBe("col");
    expect(scope.has("off")).toBe(false);
  });
});

describe("sending requests", () => {
  it("sends method, query, headers and a JSON body, with variables", async () => {
    const r = await run(def({ method: "POST", url: "{{base}}/echo?x=1", headers: [{ key: "X-Test", value: "{{v}}", enabled: true }, { key: "X-Off", value: "no", enabled: false }], body: { mode: "raw", language: "json", raw: '{"a":"{{v}}"}' } }), { base, v: "hi" });
    expect(r.status).toBe(200);
    const echoed = JSON.parse(r.body);
    expect(echoed).toMatchObject({ method: "POST", path: "/echo", query: { x: "1" }, body: '{"a":"hi"}' });
    expect(echoed.headers["x-test"]).toBe("hi");
    expect(echoed.headers["x-off"]).toBeUndefined();
    expect(echoed.headers["content-type"]).toBe("application/json");
  });

  it("applies bearer, basic and api-key auth", async () => {
    const bearer = JSON.parse((await run(def({ url: `${base}/echo`, auth: { type: "bearer", token: "T" } }))).body);
    expect(bearer.headers.authorization).toBe("Bearer T");
    const basic = JSON.parse((await run(def({ url: `${base}/echo`, auth: { type: "basic", username: "u", password: "p" } }))).body);
    expect(basic.headers.authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
    const key = JSON.parse((await run(def({ url: `${base}/echo`, auth: { type: "apikey", key: "api_key", value: "K", in: "query" } }))).body);
    expect(key.query).toEqual({ api_key: "K" });
  });

  it("encodes urlencoded and multipart bodies", async () => {
    const form = JSON.parse((await run(def({ method: "POST", url: `${base}/echo`, body: { mode: "urlencoded", fields: [{ key: "a b", value: "c&d", enabled: true }] } }))).body);
    expect(form.body).toBe("a%20b=c%26d");
    const multi = JSON.parse((await run(def({ method: "POST", url: `${base}/echo`, body: { mode: "formdata", fields: [{ key: "f", value: "v", enabled: true, type: "text" }] } }))).body);
    expect(multi.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(multi.body).toContain('name="f"');
  });

  it("follows redirects (and reports them), or stops when asked", async () => {
    const r = await run(def({ url: `${base}/redirect` }));
    expect(JSON.parse(r.body).query).toEqual({ redirected: "1" });
    expect(r.redirects).toHaveLength(1);
    const stop = await send(prepare(def({ url: `${base}/redirect` }), new Map(), { type: "none" }), { ...opts, followRedirects: false });
    expect(stop.status).toBe(302);
  });

  it("decompresses gzip, lists cookies, and treats images as binary", async () => {
    expect(JSON.parse((await run(def({ url: `${base}/gzip` }))).body)).toEqual({ zipped: true });
    expect((await run(def({ url: `${base}/cookie` }))).cookies).toEqual(["a=1; Path=/", "b=2"]);
    const bin = await run(def({ url: `${base}/bin` }));
    expect(bin.binary).toBe(true);
    expect(Buffer.from(bin.body, "base64").length).toBe(7);
  });

  it("explains a refused connection", async () => {
    await expect(run(def({ url: "http://127.0.0.1:1/" }))).rejects.toThrow(/refused|reset|answer/i);
  });
});

describe("curl", () => {
  it("tokenizes quotes and line continuations", () => {
    expect(tokenize(`curl -H 'A: b c' "x y" \\\n  --data-raw $'l1\\nl2'`)).toEqual(["curl", "-H", "A: b c", "x y", "--data-raw", "l1\nl2"]);
  });

  it("parses a typical JSON POST with bearer auth", () => {
    const { request } = parseCurl(`curl -X POST 'https://api.example.com/v1/items?x=1' -H 'Content-Type: application/json' -H 'Authorization: Bearer abc' -d '{"a":1}'`);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.example.com/v1/items?x=1");
    expect(request.auth).toEqual({ type: "bearer", token: "abc" });
    expect(request.body).toEqual({ mode: "raw", language: "json", raw: '{"a":1}' });
  });

  it("parses -u, -F, form data and defaults the method", () => {
    expect(parseCurl("curl -u me:pw https://h/x").request.auth).toEqual({ type: "basic", username: "me", password: "pw" });
    const form = parseCurl("curl -F a=1 -F f=@/tmp/x.txt https://h/up").request;
    expect(form.method).toBe("POST");
    expect(form.body).toMatchObject({ mode: "formdata", fields: [{ key: "a", value: "1", type: "text" }, { key: "f", value: "/tmp/x.txt", type: "file" }] });
    expect(parseCurl("curl -d 'a=1&b=2' https://h/x").request.body).toMatchObject({ mode: "urlencoded", fields: [{ key: "a", value: "1" }, { key: "b", value: "2" }] });
  });

  it("rejects text that is not curl", () => {
    expect(() => parseCurl("wget https://x")).toThrow(/curl/);
    expect(() => parseCurl("curl -X POST")).toThrow(/URL/);
  });

  it("generates a curl command", () => {
    expect(toCurl({ method: "POST", url: "https://h/x", headers: [["A", "b'c"]], body: "{}" })).toBe(`curl -X POST 'https://h/x' \\\n  -H 'A: b'\\''c' \\\n  --data-raw '{}'`);
  });
});

const POSTMAN = {
  info: { name: "Pets", description: "Pet store", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}", type: "string" }] },
  variable: [{ key: "baseUrl", value: "https://pets.example.com" }],
  event: [{ listen: "prerequest", script: { exec: ["console.log(1)"] } }],
  item: [
    {
      name: "Pets",
      item: [
        {
          name: "Create pet",
          request: {
            method: "POST",
            header: [{ key: "X-Id", value: "1" }, { key: "X-Skip", value: "z", disabled: true }],
            url: { raw: "{{baseUrl}}/pets?dry=1", protocol: "https", host: ["{{baseUrl}}"], path: ["pets"], query: [{ key: "dry", value: "1" }] },
            body: { mode: "raw", raw: '{"name":"Rex"}', options: { raw: { language: "json" } } },
            auth: { type: "noauth" },
          },
        },
      ],
    },
    { name: "List", request: { method: "GET", url: "{{baseUrl}}/pets", auth: { type: "basic", basic: [{ key: "username", value: "u" }, { key: "password", value: "p" }] } }, event: [{ listen: "test", script: {} }] },
    { name: "Login", request: { method: "POST", url: { raw: "{{baseUrl}}/login" }, body: { mode: "urlencoded", urlencoded: [{ key: "u", value: "a" }] } } },
    { name: "Oauth", request: { method: "GET", url: "x", auth: { type: "oauth2", oauth2: [] } } },
  ],
};

describe("Postman", () => {
  it("imports a v2.1 collection: folders, headers, bodies, auth, variables", () => {
    expect(isPostmanCollection(POSTMAN)).toBe(true);
    const { collection, report } = importCollection(POSTMAN);
    expect(collection.name).toBe("Pets");
    expect(collection.auth).toEqual({ type: "bearer", token: "{{token}}" });
    expect(collection.variables).toEqual([{ key: "baseUrl", value: "https://pets.example.com", enabled: true }]);
    expect(report).toMatchObject({ requests: 4, folders: 1, scripts: 2 });
    expect(report.warnings.join(" ")).toMatch(/oauth2/);

    const folder = collection.items[0]!;
    expect(folder.type).toBe("folder");
    const create = folder.type === "folder" ? folder.items[0]! : folder;
    expect(create.type === "request" && create.request).toMatchObject({
      method: "POST",
      url: "{{baseUrl}}/pets?dry=1",
      auth: { type: "none" },
      body: { mode: "raw", language: "json", raw: '{"name":"Rex"}' },
      headers: [{ key: "X-Id", value: "1", enabled: true }, { key: "X-Skip", value: "z", enabled: false }],
    });
    const list = collection.items[1]!;
    expect(list.type === "request" && list.request.auth).toEqual({ type: "basic", username: "u", password: "p" });
    const login = collection.items[2]!;
    expect(login.type === "request" && login.request.body).toEqual({ mode: "urlencoded", fields: [{ key: "u", value: "a", enabled: true }] });
  });

  it("imports v2.0 style auth objects and an environment", () => {
    const { collection } = importCollection({ info: { name: "Old" }, item: [{ name: "r", request: { url: "http://x", method: "GET", auth: { type: "bearer", bearer: { token: "T" } } } }] });
    const r = collection.items[0]!;
    expect(r.type === "request" && r.request.auth).toEqual({ type: "bearer", token: "T" });

    const envDoc = { name: "Dev", values: [{ key: "a", value: "1", enabled: true }, { key: "s", value: "x", enabled: false, type: "secret" }], _postman_variable_scope: "environment" };
    expect(isPostmanEnvironment(envDoc)).toBe(true);
    expect(importEnvironment(envDoc).variables).toEqual([{ key: "a", value: "1", enabled: true }, { key: "s", value: "x", enabled: false, secret: true }]);
  });

  it("exports a v2.1 collection that imports back to the same requests", () => {
    const { collection } = importCollection(POSTMAN);
    const exported = exportCollection(collection);
    expect((exported.info as { schema: string }).schema).toContain("v2.1.0");
    const again = importCollection(exported).collection;
    const strip = (c: typeof collection) => JSON.stringify(c, (k, v) => (k === "id" ? undefined : v));
    expect(strip(again)).toBe(strip(collection));
  });
});

describe("workspace file", () => {
  it("migrates an unversioned file and refuses a newer one", () => {
    expect(migrateWorkspace({ collections: [{ id: "c" }] }).version).toBe(1);
    expect(migrateWorkspace({}).environments).toEqual([]);
    expect(() => migrateWorkspace({ version: 99 })).toThrow(/newer version/);
  });
});

describe("api (workspace + send)", () => {
  let home: string;
  const prev = process.env.ONECLIENT_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "oneclient-http-"));
    process.env.ONECLIENT_HOME = home;
  });
  afterAll(() => {
    process.env.ONECLIENT_HOME = prev ?? "";
  });

  const api = async (cid: string, method: string, params: Record<string, unknown> = {}) => {
    const r = await callApi(cid, method, params);
    if (!r.ok) throw new Error(r.error);
    return r.data as Record<string, any>;
  };

  it("imports Postman, resolves inherited auth and environment variables when sending, and records history", async () => {
    const cid = `t-${Date.now()}`;
    const col = { info: { name: "C" }, auth: { type: "bearer", bearer: [{ key: "token", value: "{{tok}}" }] }, variable: [{ key: "base", value: base }], item: [{ name: "Echo", request: { method: "GET", url: "{{base}}/echo?e={{env}}" } }] };
    const imp = await api(cid, "importText", { text: JSON.stringify(col) });
    expect(imp.kind).toBe("collection");
    const env = await api(cid, "saveEnvironment", { environment: { name: "dev", variables: [{ key: "tok", value: "SECRET", enabled: true }, { key: "env", value: "dev", enabled: true }] } });
    await api(cid, "setActiveEnvironment", { id: env.id });

    const overview = await api(cid, "overview");
    const collectionId = overview.collections[0].id;
    expect(overview.collections[0].requests).toBe(1);
    const itemId = (await api(cid, "getCollection", { id: collectionId })) && (await api(cid, "overview")).collections[0].id;
    expect(itemId).toBe(collectionId);

    // find the request id through the workspace file
    const ws = (await import("../src/store.js")).workspaceFor(cid).get();
    const requestId = ws.collections[0]!.items[0]!.id;
    const got = await api(cid, "getRequest", { id: requestId });
    expect(got.request.auth).toEqual({ type: "inherit" });

    const sent = await api(cid, "send", { itemId: requestId, request: got.request });
    const echoed = JSON.parse(sent.response.body);
    expect(echoed.query).toEqual({ e: "dev" });
    expect(echoed.headers.authorization).toBe("Bearer SECRET");
    expect(sent.sent.headers.join("\n")).toContain("Authorization: ••••••");
    expect(sent.unresolved).toEqual([]);

    const history = (await api(cid, "history")) as unknown as Array<{ status: number }>;
    expect(history[0]?.status).toBe(200);

    const exported = await api(cid, "exportCollection", { id: collectionId });
    expect(exported.fileName).toBe("C.postman_collection.json");
    expect(JSON.parse(exported.json).item[0].name).toBe("Echo");
    rmSync(home, { recursive: true, force: true });
  });

  it("imports a curl command into an 'Imported requests' collection", async () => {
    const cid = `t2-${Date.now()}`;
    const r = await api(cid, "importText", { text: `curl -X PUT ${base}/things/1 -H 'Content-Type: application/json' -d '{"x":1}'` });
    expect(r.kind).toBe("curl");
    const o = await api(cid, "overview");
    expect(o.collections[0].name).toBe("Imported requests");
    await expect(api(cid, "importText", { text: "hello" })).rejects.toThrow(/JSON or a curl/);
  });

  it("creates, renames, duplicates and deletes items", async () => {
    const cid = `t3-${Date.now()}`;
    const c = await api(cid, "create", { kind: "collection", name: "A" });
    const f = await api(cid, "create", { kind: "folder", parentId: c.id, name: "F" });
    const r = await api(cid, "create", { kind: "request", parentId: f.id, name: "R" });
    await api(cid, "rename", { id: r.id, name: "R2" });
    const copy = await api(cid, "duplicate", { id: f.id });
    expect(copy.id).not.toBe(f.id);
    expect((await api(cid, "overview")).collections[0].requests).toBe(2);
    await api(cid, "remove", { id: f.id });
    expect((await api(cid, "overview")).collections[0].requests).toBe(1);
    await expect(api(cid, "getRequest", { id: r.id })).rejects.toThrow(/no longer exists/);
  });
});
