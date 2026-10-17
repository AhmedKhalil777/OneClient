import { useCallback, useEffect, useState } from "react";
import { type Json, api, qs, useToast } from "./kit.js";

interface Role {
  id: string;
  name: string;
  description?: string;
  composite?: boolean;
}

/** Moves roles between "assigned" and "available" for the realm or one client. */
function RolePicker({ assigned, available, busy, onChange }: { assigned: Role[]; available: Role[]; busy: boolean; onChange: (add: Role[], remove: Role[]) => void }) {
  const [pickA, setPickA] = useState<Set<string>>(new Set());
  const [pickB, setPickB] = useState<Set<string>>(new Set());
  useEffect(() => {
    setPickA(new Set());
    setPickB(new Set());
  }, [assigned, available]);

  const toggle = (set: Set<string>, setSet: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSet(next);
  };
  const list = (roles: Role[], picked: Set<string>, setPicked: (s: Set<string>) => void) => (
    <div className="kc-list">
      {roles.length === 0 && <div className="kc-muted" style={{ padding: "4px 10px" }}>None</div>}
      {roles.map((r) => (
        <label className="kc-item" key={r.id || r.name} title={r.description}>
          <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(picked, setPicked, r.id)} />
          <span>{r.name}</span>
          {r.composite && <span className="kc-badge off">composite</span>}
        </label>
      ))}
    </div>
  );
  return (
    <div className="kc-split">
      <div className="kc-box">
        <h4>
          <span>Assigned ({assigned.length})</span>
          <button className="kc-link" disabled={busy || pickA.size === 0} onClick={() => onChange([], assigned.filter((r) => pickA.has(r.id)))}>
            Remove selected
          </button>
        </h4>
        {list(assigned, pickA, setPickA)}
      </div>
      <div className="kc-box">
        <h4>
          <span>Available ({available.length})</span>
          <button className="kc-link" disabled={busy || pickB.size === 0} onClick={() => onChange(available.filter((r) => pickB.has(r.id)), [])}>
            Assign selected
          </button>
        </h4>
        {list(available, pickB, setPickB)}
      </div>
    </div>
  );
}

/** Role mappings and group membership for one user or group. */
export function Mappings() {
  const subject = qs.get("subject") === "group" ? "group" : "user";
  const realm = qs.get("realm") ?? "";
  const id = qs.get("id") ?? "";
  const name = qs.get("name") ?? id;

  const [overview, setOverview] = useState<{ realm: { assigned: Role[]; available: Role[]; effective: Role[] }; clients: Array<{ id: string; clientId: string; assigned: Role[] }> } | null>(null);
  const [groups, setGroups] = useState<{ member: Json[]; all: Json[] } | null>(null);
  const [clients, setClients] = useState<Json[]>([]);
  const [clientId, setClientId] = useState("");
  const [clientRoles, setClientRoles] = useState<{ assigned: Role[]; available: Role[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, say] = useToast();

  const loadMain = useCallback(async () => {
    const r = await api<NonNullable<typeof overview>>("mappings", { subject, realm, id });
    if (!r.ok) return setError(r.error);
    setError("");
    setOverview(r.data);
    if (subject === "user") {
      const g = await api<{ member: Json[]; all: Json[] }>("userGroups", { realm, id });
      if (g.ok) setGroups(g.data);
    }
  }, [subject, realm, id]);

  const loadClient = useCallback(
    async (uuid: string) => {
      if (!uuid) return setClientRoles(null);
      const r = await api<{ assigned: Role[]; available: Role[] }>("clientMappings", { subject, realm, id, clientUuid: uuid });
      if (r.ok) setClientRoles(r.data);
      else say(r.error, true);
    },
    [subject, realm, id, say],
  );

  useEffect(() => {
    void loadMain();
    void api<{ items: Json[] }>("list", { kind: "client", realm, max: 500 }).then((r) => {
      if (r.ok) setClients([...r.data.items].sort((a, b) => String(a.clientId).localeCompare(String(b.clientId))));
    });
  }, [loadMain, realm]);

  useEffect(() => {
    void loadClient(clientId);
  }, [clientId, loadClient]);

  const change = async (scope: "realm" | "client", add: Role[], remove: Role[]) => {
    setBusy(true);
    const r = await api("updateMappings", { subject, realm, id, scope, ...(scope === "client" ? { clientUuid: clientId } : {}), add, remove });
    setBusy(false);
    if (!r.ok) return say(r.error, true);
    say("Updated.");
    await loadMain();
    if (scope === "client") await loadClient(clientId);
  };

  const membership = async (groupId: string, join: boolean) => {
    setBusy(true);
    const r = await api("setMembership", { realm, id, join: join ? [groupId] : [], leave: join ? [] : [groupId] });
    setBusy(false);
    if (!r.ok) return say(r.error, true);
    await loadMain();
  };

  if (error) return <div className="kc-message kc-error">{error}</div>;
  if (!overview) return <div className="kc-message">Loading…</div>;

  const memberIds = new Set((groups?.member ?? []).map((g) => g.id));

  return (
    <div className="kc-page">
      <div className="kc-bar">
        <span className="kc-title">Access — {name}</span>
        <span className="kc-muted">
          {subject} · {realm}
        </span>
        <span className="kc-spacer" />
        <button className="oce-btn" onClick={() => void loadMain()}>
          Refresh
        </button>
      </div>
      <div className="kc-body">
        <h2 className="kc-h" style={{ marginTop: 0 }}>
          Realm roles
        </h2>
        <RolePicker assigned={overview.realm.assigned} available={overview.realm.available} busy={busy} onChange={(add, remove) => void change("realm", add, remove)} />

        <h2 className="kc-h">Client roles</h2>
        <div className="kc-row" style={{ marginBottom: 8 }}>
          <select className="kc-select" value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">Choose a client…</option>
            {clients.map((c) => {
              const n = overview.clients.find((x) => x.id === c.id)?.assigned.length ?? 0;
              return (
                <option key={c.id} value={c.id}>
                  {c.clientId}
                  {n ? ` (${n})` : ""}
                </option>
              );
            })}
          </select>
          {overview.clients.length > 0 && !clientId && (
            <span className="kc-muted">Has roles from: {overview.clients.map((c) => c.clientId).join(", ")}</span>
          )}
        </div>
        {clientRoles && <RolePicker assigned={clientRoles.assigned} available={clientRoles.available} busy={busy} onChange={(add, remove) => void change("client", add, remove)} />}

        {subject === "user" && groups && (
          <>
            <h2 className="kc-h">Groups</h2>
            <div className="kc-box">
              <div className="kc-list">
                {groups.all.length === 0 && <div className="kc-muted" style={{ padding: "4px 10px" }}>This realm has no groups.</div>}
                {groups.all.map((g) => (
                  <label className="kc-item" key={g.id}>
                    <input type="checkbox" disabled={busy} checked={memberIds.has(g.id)} onChange={(e) => void membership(String(g.id), e.target.checked)} />
                    <span>{g.path}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}

        <h2 className="kc-h">Effective realm roles ({overview.realm.effective.length})</h2>
        <div className="kc-row">
          {overview.realm.effective.map((r) => (
            <span className="kc-badge" key={r.id}>
              {r.name}
            </span>
          ))}
        </div>
      </div>
      {toast}
    </div>
  );
}
