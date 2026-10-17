import { useEffect, useState } from "react";
import { decodeJwt, rolesOf, timeClaims } from "../src/jwt.js";
import { type Json, api, copy, openResource, useToast } from "./kit.js";

type Tab = "token" | "decode" | "introspect" | "evaluate" | "endpoints";
const TABS: Array<[Tab, string]> = [
  ["token", "Get token"],
  ["decode", "Decode JWT"],
  ["introspect", "Introspect / UserInfo"],
  ["evaluate", "Evaluate"],
  ["endpoints", "Endpoints"],
];

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

function TokenView({ token, label }: { token: string; label?: string }) {
  const r = decodeJwt(token);
  if (!r.ok) return <div className="kc-error">{label ? `${label}: ` : ""}{r.error}</div>;
  const { header, payload } = r.jwt;
  const roles = rolesOf(payload);
  const times = timeClaims(payload);
  return (
    <div>
      {label && <h2 className="kc-h">{label}</h2>}
      {times.length > 0 && (
        <table className="kc-table" style={{ width: "auto", marginBottom: 8 }}>
          <tbody>
            {times.map((t) => (
              <tr key={t.claim}>
                <td>{t.claim}</td>
                <td>{new Date(t.iso).toLocaleString()}</td>
                <td className="kc-muted">{t.relative}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(roles.realm.length > 0 || Object.keys(roles.clients).length > 0) && (
        <div className="kc-row" style={{ marginBottom: 8 }}>
          {roles.realm.map((x) => (
            <span className="kc-badge" key={`r:${x}`}>
              {x}
            </span>
          ))}
          {Object.entries(roles.clients).flatMap(([c, rs]) => rs.map((x) => <span className="kc-badge off" key={`${c}:${x}`}>{c}: {x}</span>))}
        </div>
      )}
      <div className="kc-split">
        <pre className="kc-pre">{pretty(header)}</pre>
        <pre className="kc-pre">{pretty(payload)}</pre>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kc-field">
      <label>{label}</label>
      {children}
    </div>
  );
}

/** Developer tools: get/decode/introspect tokens, evaluate what a client would receive, and jump to a realm's endpoints. */
export function Tools() {
  const [tab, setTab] = useState<Tab>("token");
  const [realms, setRealms] = useState<string[]>([]);
  const [realm, setRealm] = useState("");
  const [toast, say] = useToast();

  useEffect(() => {
    void api<Array<{ realm: string }>>("realms").then((r) => {
      if (!r.ok) return say(r.error, true);
      const names = r.data.map((x) => x.realm);
      setRealms(names);
      setRealm((cur) => cur || names.find((n) => n !== "master") || names[0] || "");
    });
  }, [say]);

  return (
    <div className="kc-page">
      <div className="kc-bar">
        <span className="kc-title">Developer Tools</span>
        <label className="kc-muted">Realm</label>
        <select className="kc-select" value={realm} onChange={(e) => setRealm(e.target.value)}>
          {realms.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </div>
      <div className="kc-tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={`kc-tab${tab === id ? " on" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="kc-body">
        {tab === "token" && <GetToken realm={realm} say={say} />}
        {tab === "decode" && <Decode />}
        {tab === "introspect" && <Introspect realm={realm} />}
        {tab === "evaluate" && <Evaluate realm={realm} />}
        {tab === "endpoints" && <Endpoints realm={realm} />}
      </div>
      {toast}
    </div>
  );
}

function Raw({ result }: { result: { status: number; body: unknown } | null }) {
  if (!result) return null;
  return (
    <>
      <h2 className="kc-h">
        Response <span className={result.status < 300 ? "kc-ok" : "kc-error"}>HTTP {result.status}</span>
      </h2>
      <pre className="kc-pre">{typeof result.body === "string" ? result.body : pretty(result.body)}</pre>
    </>
  );
}

function GetToken({ realm, say }: { realm: string; say: (t: string, e?: boolean) => void }) {
  const [f, setF] = useState({ clientId: "", clientSecret: "", grant: "password", username: "", password: "", scope: "openid", refreshToken: "" });
  const [res, setRes] = useState<{ status: number; body: Json } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  const run = async () => {
    setBusy(true);
    const r = await api<{ status: number; body: Json }>("getToken", { realm, ...f });
    setBusy(false);
    if (!r.ok) return say(r.error, true);
    setRes(r.data);
  };
  const body = res?.body;
  return (
    <>
      <div className="kc-split">
        <Field label="Client ID *">
          <input className="kc-input" value={f.clientId} onChange={set("clientId")} />
        </Field>
        <Field label="Client secret (confidential clients)">
          <input className="kc-input" type="password" value={f.clientSecret} onChange={set("clientSecret")} />
        </Field>
        <Field label="Grant type">
          <select className="kc-select" value={f.grant} onChange={set("grant")}>
            <option value="password">Password (direct access)</option>
            <option value="client_credentials">Client credentials</option>
            <option value="refresh_token">Refresh token</option>
          </select>
        </Field>
        <Field label="Scope">
          <input className="kc-input" value={f.scope} onChange={set("scope")} placeholder="openid" />
        </Field>
        {f.grant === "password" && (
          <>
            <Field label="Username">
              <input className="kc-input" value={f.username} onChange={set("username")} />
            </Field>
            <Field label="Password">
              <input className="kc-input" type="password" value={f.password} onChange={set("password")} />
            </Field>
          </>
        )}
        {f.grant === "refresh_token" && (
          <Field label="Refresh token">
            <input className="kc-input" value={f.refreshToken} onChange={set("refreshToken")} />
          </Field>
        )}
      </div>
      <div className="kc-row" style={{ margin: "10px 0" }}>
        <button className="oce-btn oce-btn-primary" disabled={busy || !realm || !f.clientId} onClick={() => void run()}>
          Request token
        </button>
        {typeof body?.access_token === "string" && (
          <button className="oce-btn" onClick={async () => say((await copy(String(body.access_token))) ? "Access token copied." : "Couldn't copy.")}>
            Copy access token
          </button>
        )}
        {typeof body?.refresh_token === "string" && (
          <button className="oce-btn" onClick={() => setF({ ...f, grant: "refresh_token", refreshToken: String(body.refresh_token) })}>
            Use refresh token
          </button>
        )}
      </div>
      {typeof body?.access_token === "string" && <TokenView token={body.access_token} label="Access token" />}
      {typeof body?.id_token === "string" && <TokenView token={body.id_token} label="ID token" />}
      {typeof body?.refresh_token === "string" && <TokenView token={body.refresh_token} label="Refresh token" />}
      <Raw result={res} />
    </>
  );
}

function Decode() {
  const [token, setToken] = useState("");
  return (
    <>
      <Field label="Paste a JWT (decoded locally — the signature is not verified)">
        <textarea className="kc-textarea" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJhbGciOi…" />
      </Field>
      {token.trim() && <TokenView token={token} />}
    </>
  );
}

function Introspect({ realm }: { realm: string }) {
  const [f, setF] = useState({ clientId: "", clientSecret: "", token: "" });
  const [res, setRes] = useState<{ status: number; body: unknown } | null>(null);
  const [err, setErr] = useState("");
  const call = async (method: "introspect" | "userInfo") => {
    setErr("");
    const r = await api<{ status: number; body: unknown }>(method, { realm, ...f });
    if (!r.ok) {
      setRes(null);
      return setErr(r.error);
    }
    setRes(r.data);
  };
  return (
    <>
      <div className="kc-split">
        <Field label="Client ID (introspection)">
          <input className="kc-input" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} />
        </Field>
        <Field label="Client secret (introspection)">
          <input className="kc-input" type="password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} />
        </Field>
      </div>
      <Field label="Access token">
        <textarea className="kc-textarea" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />
      </Field>
      <div className="kc-row" style={{ margin: "10px 0" }}>
        <button className="oce-btn oce-btn-primary" disabled={!f.token.trim() || !f.clientId} onClick={() => void call("introspect")}>
          Introspect
        </button>
        <button className="oce-btn" disabled={!f.token.trim()} onClick={() => void call("userInfo")}>
          UserInfo
        </button>
      </div>
      {err && <div className="kc-error">{err}</div>}
      <Raw result={res} />
    </>
  );
}

function Evaluate({ realm }: { realm: string }) {
  const [clients, setClients] = useState<Json[]>([]);
  const [clientUuid, setClientUuid] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [users, setUsers] = useState<Json[]>([]);
  const [userId, setUserId] = useState("");
  const [what, setWhat] = useState("access");
  const [scope, setScope] = useState("");
  const [out, setOut] = useState<unknown>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    setClientUuid("");
    setUserId("");
    setUsers([]);
    if (realm) void api<{ items: Json[] }>("list", { kind: "client", realm, max: 500 }).then((r) => r.ok && setClients(r.data.items));
  }, [realm]);

  const findUsers = async () => {
    const r = await api<{ items: Json[] }>("list", { kind: "user", realm, search: userQuery, max: 20 });
    if (r.ok) {
      setUsers(r.data.items);
      setUserId(String(r.data.items[0]?.id ?? ""));
    } else setErr(r.error);
  };
  const run = async () => {
    setErr("");
    const r = await api("exampleToken", { realm, clientUuid, userId, what, scope });
    if (r.ok) setOut(r.data);
    else {
      setOut(null);
      setErr(r.error);
    }
  };
  return (
    <>
      <div className="kc-muted" style={{ marginBottom: 8 }}>Shows the claims the server would put in a token for a user and client — without logging anyone in.</div>
      <div className="kc-split">
        <Field label="Client">
          <select className="kc-select" value={clientUuid} onChange={(e) => setClientUuid(e.target.value)}>
            <option value="">Choose…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.clientId}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Token">
          <select className="kc-select" value={what} onChange={(e) => setWhat(e.target.value)}>
            <option value="access">Access token</option>
            <option value="id">ID token</option>
            <option value="userinfo">UserInfo</option>
          </select>
        </Field>
        <Field label="User">
          <div className="kc-row">
            <input className="kc-input" placeholder="Search users…" value={userQuery} onChange={(e) => setUserQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void findUsers()} />
            <button className="oce-btn" onClick={() => void findUsers()}>
              Find
            </button>
          </div>
          {users.length > 0 && (
            <select className="kc-select" value={userId} onChange={(e) => setUserId(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Extra scopes (space separated)">
          <input className="kc-input" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="openid profile" />
        </Field>
      </div>
      <div className="kc-row" style={{ margin: "10px 0" }}>
        <button className="oce-btn oce-btn-primary" disabled={!clientUuid || !userId} onClick={() => void run()}>
          Evaluate
        </button>
      </div>
      {err && <div className="kc-error">{err}</div>}
      {out !== null && <pre className="kc-pre">{pretty(out)}</pre>}
    </>
  );
}

function Endpoints({ realm }: { realm: string }) {
  const [wk, setWk] = useState<Json | null>(null);
  useEffect(() => {
    setWk(null);
    if (realm) void api<{ doc: Json }>("document", { kind: "wellKnown", realm }).then((r) => r.ok && setWk(r.data.doc));
  }, [realm]);
  const entries = wk ? Object.entries(wk).filter(([, v]) => typeof v === "string" && /^https?:/.test(v)) : [];
  return (
    <>
      <div className="kc-row" style={{ marginBottom: 10 }}>
        <button className="oce-btn" onClick={() => openResource(`Discovery — ${realm}`, { kind: "wellKnown", realm }, "$(globe)")}>
          OpenID configuration
        </button>
        <button className="oce-btn" onClick={() => openResource(`JWKS — ${realm}`, { kind: "jwks", realm }, "$(key)")}>
          Public keys (JWKS)
        </button>
        <button className="oce-btn" onClick={() => openResource(`Export — ${realm}`, { kind: "export", realm }, "$(cube)")}>
          Export realm
        </button>
        <button className="oce-btn" onClick={() => openResource("Server info", { kind: "serverInfo", realm: "master" }, "$(server)")}>
          Server info
        </button>
      </div>
      <table className="kc-table">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>
                <button className="kc-link" onClick={() => void window.oneclientView.openExternal(String(v))}>
                  {String(v)}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
