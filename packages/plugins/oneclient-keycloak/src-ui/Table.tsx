import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Badge, ConfirmDialog, FormDialog, Modal, type Json, api, copy, fmtTime, open, openResource, qs, useToast } from "./kit.js";

interface Col {
  label: string;
  cell: (row: Json) => ReactNode;
}
interface Act {
  label: string;
  run: (row: Json) => void;
  show?: (row: Json) => boolean;
}
interface Page {
  items: Json[];
  hasMore: boolean;
  total?: number;
}
interface Ctx {
  realm: string;
  parent: string | undefined;
  reload: () => void;
  say: (t: string, err?: boolean) => void;
  dialog: (d: ReactNode) => void;
  drill: (d: { id: string; clientId: string } | null) => void;
}
interface Cfg {
  title: string;
  icon: string;
  columns: Col[];
  searchable?: boolean;
  load: (p: { search: string; first: number; max: number; filters: Json; drill: { id: string; clientId: string } | null }) => Promise<{ ok: true; data: Page } | { ok: false; error: string }>;
  key: (row: Json) => string;
  actions: (c: Ctx) => Act[];
  /** The "New …" button. */
  create?: (c: Ctx) => { label: string; run: () => void };
  /** Click on the first-column link. */
  openRow?: (row: Json, c: Ctx) => void;
  filters?: Array<{ key: string; label: string; type?: "text" | "date" }>;
  pageSize?: number;
}

const PAGE = 50;
const dash = (v: unknown) => (v === undefined || v === null || v === "" ? <span className="kc-muted">—</span> : String(v));

function confirmDelete(c: Ctx, kind: string, label: string, params: Record<string, unknown>) {
  c.dialog(
    <ConfirmDialog
      title={`Delete ${kind}`}
      text={`Delete ${label}? This cannot be undone.`}
      onClose={() => c.dialog(null)}
      onConfirm={async () => {
        const r = await api("remove", { realm: c.realm, ...params });
        if (!r.ok) c.say(r.error, true);
        else {
          c.say("Deleted.");
          c.reload();
        }
      }}
    />,
  );
}

function toggleEnabled(c: Ctx, kind: string, id: string, enabled: boolean) {
  void api("setEnabled", { kind, realm: c.realm, id, enabled }).then((r) => {
    if (!r.ok) c.say(r.error, true);
    else c.reload();
  });
}

const openJson = (kind: string, title: string, c: Ctx, id: string, icon: string, parent?: string) =>
  openResource(`${title} — ${c.realm}`, { kind, realm: c.realm, id, ...(parent ? { parent } : {}) }, icon);

function showUsers(c: Ctx, title: string, users: Json[]) {
  c.dialog(
    <Modal title={title} onClose={() => c.dialog(null)}>
      {users.length === 0 ? (
        <div className="kc-muted">No users.</div>
      ) : (
        <div className="kc-list">
          {users.map((u) => (
            <div className="kc-item" key={u.id}>
              <button className="kc-link" onClick={() => openJson("user", String(u.username), c, String(u.id), "$(user)")}>
                {u.username}
              </button>
              <span className="kc-muted">{u.email}</span>
            </div>
          ))}
        </div>
      )}
      <div className="kc-row" style={{ justifyContent: "flex-end" }}>
        <button className="oce-btn oce-btn-primary" onClick={() => c.dialog(null)}>
          Close
        </button>
      </div>
    </Modal>,
  );
}

function configFor(kind: string, realm: string, parent: string | undefined): Cfg | null {
  const list = (k: string) => (p: { search: string; first: number; max: number }) => api<Page>("list", { kind: k, realm, parent, search: p.search, first: p.first, max: p.max });

  switch (kind) {
    case "users":
      return {
        title: "Users",
        icon: "$(user)",
        searchable: true,
        load: list("user"),
        key: (r) => r.id,
        columns: [
          { label: "Username", cell: (r) => r.username },
          { label: "Email", cell: (r) => dash(r.email) },
          { label: "Name", cell: (r) => dash([r.firstName, r.lastName].filter(Boolean).join(" ")) },
          { label: "Status", cell: (r) => <Badge on={r.enabled !== false} /> },
        ],
        openRow: (r, c) => openJson("user", r.username, c, r.id, "$(user)"),
        create: (c) => ({
          label: "New user",
          run: () =>
            c.dialog(
              <FormDialog
                title="New user"
                submitLabel="Create"
                fields={[
                  { key: "username", label: "Username", required: true },
                  { key: "email", label: "Email" },
                  { key: "firstName", label: "First name" },
                  { key: "lastName", label: "Last name" },
                  { key: "password", label: "Password (optional)", type: "password" },
                  { key: "temporary", label: "Password is temporary", type: "checkbox" },
                ]}
                onClose={() => c.dialog(null)}
                onSubmit={async (v) => {
                  const r = await api("createUser", { realm, ...v });
                  if (!r.ok) return r.error;
                  c.say("User created.");
                  c.reload();
                }}
              />,
            ),
        }),
        actions: (c) => [
          { label: "Open", run: (r) => openJson("user", r.username, c, r.id, "$(user)") },
          { label: "Roles & groups", run: (r) => open("keycloak.mappings", `Access — ${r.username}`, { subject: "user", id: r.id, realm, name: r.username }, "$(shield)") },
          { label: "Disable", show: (r) => r.enabled !== false, run: (r) => toggleEnabled(c, "user", r.id, false) },
          { label: "Enable", show: (r) => r.enabled === false, run: (r) => toggleEnabled(c, "user", r.id, true) },
          {
            label: "Reset password",
            run: (r) =>
              c.dialog(
                <FormDialog
                  title={`Reset password — ${r.username}`}
                  submitLabel="Reset"
                  fields={[
                    { key: "password", label: "New password", type: "password", required: true },
                    { key: "temporary", label: "Require change at next login", type: "checkbox" },
                  ]}
                  onClose={() => c.dialog(null)}
                  onSubmit={async (v) => {
                    const x = await api("resetPassword", { realm, id: r.id, ...v });
                    if (!x.ok) return x.error;
                    c.say("Password reset.");
                  }}
                />,
              ),
          },
          { label: "Sign out", run: (r) => void api("logoutUser", { realm, id: r.id }).then((x) => c.say(x.ok ? "Signed out of all sessions." : x.error, !x.ok)) },
          { label: "Unlock", run: (r) => void api("unlockUser", { realm, id: r.id }).then((x) => c.say(x.ok ? "Unlocked." : x.error, !x.ok)) },
          { label: "Delete", run: (r) => confirmDelete(c, "user", r.username, { kind: "user", id: r.id }) },
        ],
      };

    case "clients":
      return {
        title: "Clients",
        icon: "$(window)",
        searchable: true,
        load: list("client"),
        key: (r) => r.id,
        columns: [
          { label: "Client ID", cell: (r) => r.clientId },
          { label: "Name", cell: (r) => dash(r.name) },
          { label: "Protocol", cell: (r) => dash(r.protocol) },
          { label: "Access", cell: (r) => (r.bearerOnly ? "bearer-only" : r.publicClient ? "public" : "confidential") },
          { label: "Status", cell: (r) => <Badge on={r.enabled !== false} /> },
        ],
        openRow: (r, c) => openJson("client", r.clientId, c, r.id, "$(window)"),
        create: () => ({ label: "New client", run: () => openResource(`New client — ${realm}`, { kind: "client", realm, mode: "create" }, "$(window)") }),
        actions: (c) => [
          { label: "Open", run: (r) => openJson("client", r.clientId, c, r.id, "$(window)") },
          {
            label: "Secret",
            show: (r) => !r.publicClient && !r.bearerOnly,
            run: (r) =>
              void api<{ value?: string }>("secret", { realm, id: r.id }).then((x) => {
                if (!x.ok) return c.say(x.error, true);
                const value = x.data.value ?? "";
                c.dialog(
                  <Modal title={`Secret — ${r.clientId}`} onClose={() => c.dialog(null)}>
                    <pre className="kc-pre">{value || "(none)"}</pre>
                    <div className="kc-row" style={{ justifyContent: "flex-end" }}>
                      <button className="oce-btn" onClick={async () => c.say((await copy(value)) ? "Copied." : "Couldn't copy.")}>
                        Copy
                      </button>
                      <button
                        className="oce-btn"
                        onClick={async () => {
                          const g = await api<{ value?: string }>("secret", { realm, id: r.id, regenerate: true });
                          c.dialog(null);
                          c.say(g.ok ? "Secret regenerated." : g.error, !g.ok);
                        }}
                      >
                        Regenerate
                      </button>
                      <button className="oce-btn oce-btn-primary" onClick={() => c.dialog(null)}>
                        Close
                      </button>
                    </div>
                  </Modal>,
                );
              }),
          },
          { label: "Installation", run: (r) => openResource(`Installation — ${r.clientId}`, { kind: "installation", realm, id: r.id }, "$(file)") },
          { label: "Roles", run: (r) => open("keycloak.table", `Roles — ${r.clientId}`, { kind: "clientRole", realm, parent: r.id }, "$(tag)") },
          { label: "Sessions", run: (r) => open("keycloak.table", `Sessions — ${r.clientId}`, { kind: "sessions", realm, drillId: r.id, drillName: r.clientId }, "$(clock)") },
          { label: "Disable", show: (r) => r.enabled !== false, run: (r) => toggleEnabled(c, "client", r.id, false) },
          { label: "Enable", show: (r) => r.enabled === false, run: (r) => toggleEnabled(c, "client", r.id, true) },
          { label: "Delete", run: (r) => confirmDelete(c, "client", r.clientId, { kind: "client", id: r.id }) },
        ],
      };

    case "roles":
    case "clientRole": {
      const isClient = kind === "clientRole";
      const k = isClient ? "clientRole" : "role";
      return {
        title: isClient ? "Client roles" : "Roles",
        icon: "$(tag)",
        searchable: true,
        load: list(k),
        key: (r) => r.id ?? r.name,
        columns: [
          { label: "Name", cell: (r) => r.name },
          { label: "Description", cell: (r) => dash(r.description) },
          { label: "Composite", cell: (r) => (r.composite ? "yes" : "") },
        ],
        openRow: (r, c) => openJson(k, r.name, c, r.name, "$(tag)", parent),
        create: (c) => ({
          label: "New role",
          run: () =>
            c.dialog(
              <FormDialog
                title={isClient ? "New client role" : "New role"}
                submitLabel="Create"
                fields={[
                  { key: "name", label: "Name", required: true },
                  { key: "description", label: "Description" },
                ]}
                onClose={() => c.dialog(null)}
                onSubmit={async (v) => {
                  const r = await api("save", { kind: k, realm, parent, body: { name: v.name, ...(v.description ? { description: v.description } : {}) } });
                  if (!r.ok) return r.error;
                  c.say("Role created.");
                  c.reload();
                }}
              />,
            ),
        }),
        actions: (c) => [
          { label: "Open", run: (r) => openJson(k, r.name, c, r.name, "$(tag)", parent) },
          {
            label: "Users",
            run: (r) => void api<Json[]>("roleUsers", { realm, id: r.name, parent }).then((x) => (x.ok ? showUsers(c, `Users with ${r.name}`, x.data) : c.say(x.error, true))),
          },
          { label: "Delete", run: (r) => confirmDelete(c, "role", r.name, { kind: k, id: r.name, parent }) },
        ],
      };
    }

    case "clientScopes":
      return {
        title: "Client scopes",
        icon: "$(symbol)",
        searchable: true,
        load: list("clientScope"),
        key: (r) => r.id,
        columns: [
          { label: "Name", cell: (r) => r.name },
          { label: "Protocol", cell: (r) => dash(r.protocol) },
          { label: "Description", cell: (r) => dash(r.description) },
        ],
        openRow: (r, c) => openJson("clientScope", r.name, c, r.id, "$(symbol)"),
        create: () => ({ label: "New scope", run: () => openResource(`New client scope — ${realm}`, { kind: "clientScope", realm, mode: "create" }, "$(symbol)") }),
        actions: (c) => [
          { label: "Open", run: (r) => openJson("clientScope", r.name, c, r.id, "$(symbol)") },
          { label: "Delete", run: (r) => confirmDelete(c, "client scope", r.name, { kind: "clientScope", id: r.id }) },
        ],
      };

    case "identityProviders":
      return {
        title: "Identity providers",
        icon: "$(link)",
        searchable: true,
        load: list("identityProvider"),
        key: (r) => r.alias,
        columns: [
          { label: "Alias", cell: (r) => r.alias },
          { label: "Type", cell: (r) => dash(r.providerId) },
          { label: "Display name", cell: (r) => dash(r.displayName) },
          { label: "Status", cell: (r) => <Badge on={r.enabled !== false} /> },
        ],
        openRow: (r, c) => openJson("identityProvider", r.alias, c, r.alias, "$(link)"),
        create: () => ({ label: "New provider", run: () => openResource(`New identity provider — ${realm}`, { kind: "identityProvider", realm, mode: "create" }, "$(link)") }),
        actions: (c) => [
          { label: "Open", run: (r) => openJson("identityProvider", r.alias, c, r.alias, "$(link)") },
          { label: "Disable", show: (r) => r.enabled !== false, run: (r) => toggleEnabled(c, "identityProvider", r.alias, false) },
          { label: "Enable", show: (r) => r.enabled === false, run: (r) => toggleEnabled(c, "identityProvider", r.alias, true) },
          { label: "Delete", run: (r) => confirmDelete(c, "identity provider", r.alias, { kind: "identityProvider", id: r.alias }) },
        ],
      };

    case "flows":
      return {
        title: "Authentication flows",
        icon: "$(lock)",
        searchable: true,
        load: list("flow"),
        key: (r) => r.id ?? r.alias,
        columns: [
          { label: "Alias", cell: (r) => r.alias },
          { label: "Type", cell: (r) => dash(r.providerId) },
          { label: "Built-in", cell: (r) => (r.builtIn ? "yes" : "") },
          { label: "Description", cell: (r) => dash(r.description) },
        ],
        openRow: (r, c) => openJson("flow", r.alias, c, r.alias, "$(lock)"),
        actions: (c) => [{ label: "Open", run: (r) => openJson("flow", r.alias, c, r.alias, "$(lock)") }],
      };

    case "sessions":
      return {
        title: "Sessions",
        icon: "$(clock)",
        load: async (p) => {
          if (p.drill) return api<Page>("clientSessions", { realm, id: p.drill.id, first: p.first, max: p.max });
          return api<Page>("sessionStats", { realm });
        },
        key: (r) => r.id,
        columns: [],
        actions: () => [],
      };

    case "events":
    case "adminEvents": {
      const admin = kind === "adminEvents";
      return {
        title: admin ? "Admin events" : "Login events",
        icon: "$(bell)",
        load: (p) => api<Page>("events", { realm, events: admin ? "admin" : "login", first: p.first, max: p.max, ...p.filters }),
        key: (r) => `${r.time}|${r.type}|${r.subject}`,
        filters: admin
          ? [
              { key: "type", label: "Operation (CREATE, UPDATE, DELETE…)" },
              { key: "resourceType", label: "Resource type" },
              { key: "dateFrom", label: "From", type: "date" },
              { key: "dateTo", label: "To", type: "date" },
            ]
          : [
              { key: "type", label: "Event type (LOGIN, LOGIN_ERROR…)" },
              { key: "user", label: "User id" },
              { key: "client", label: "Client id" },
              { key: "dateFrom", label: "From", type: "date" },
              { key: "dateTo", label: "To", type: "date" },
            ],
        columns: [
          { label: "Time", cell: (r) => fmtTime(r.time) },
          { label: "Type", cell: (r) => (r.error ? <span className="kc-error">{r.type}</span> : r.type) },
          { label: admin ? "Resource" : "User", cell: (r) => dash(r.subject) },
          { label: "Client", cell: (r) => dash(r.client) },
          { label: "IP", cell: (r) => dash(r.ipAddress) },
          { label: "Error", cell: (r) => dash(r.error) },
        ],
        actions: () => [],
      };
    }
  }
  return null;
}

/** One list view for every collection: search, paging, row actions, "New …". Which collection comes from `?kind=`. */
export function Table() {
  const kind = qs.get("kind") ?? "";
  const realm = qs.get("realm") ?? "";
  const parent = qs.get("parent") ?? undefined;
  const initialDrill = qs.get("drillId") ? { id: qs.get("drillId") ?? "", clientId: qs.get("drillName") ?? "" } : null;

  const cfg = useMemo(() => configFor(kind, realm, parent), [kind, realm, parent]);
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [filters, setFilters] = useState<Json>({});
  const [appliedFilters, setAppliedFilters] = useState<Json>({});
  const [first, setFirst] = useState(0);
  const [drill, setDrill] = useState(initialDrill);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [selected, setSelected] = useState<Json | null>(null);
  const [eventsOn, setEventsOn] = useState<boolean | null>(null);
  const [toast, say] = useToast();

  const reload = useCallback(async () => {
    if (!cfg) return;
    setLoading(true);
    const r = await cfg.load({ search: applied, first, max: cfg.pageSize ?? PAGE, filters: appliedFilters, drill });
    setLoading(false);
    if (r.ok) {
      setPage(r.data);
      setError("");
    } else setError(r.error);
  }, [cfg, applied, first, appliedFilters, drill]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (kind !== "events" && kind !== "adminEvents") return;
    void api<{ doc: Json }>("document", { kind: "eventsConfig", realm }).then((r) => {
      if (r.ok) setEventsOn(kind === "events" ? r.data.doc.eventsEnabled === true : r.data.doc.adminEventsEnabled === true);
    });
  }, [kind, realm]);

  const ctx: Ctx = {
    realm,
    parent,
    reload: () => void reload(),
    say,
    dialog: setDialog,
    drill: (d) => {
      setDrill(d);
      setFirst(0);
    },
  };

  if (!cfg) return <div className="kc-message kc-error">Unknown list "{kind}".</div>;

  const acts = cfg.actions(ctx);
  const isSessionStats = kind === "sessions" && !drill;
  const isSessionRows = kind === "sessions" && !!drill;
  const max = cfg.pageSize ?? PAGE;
  const create = cfg.create?.(ctx);

  const columns: Col[] = isSessionStats
    ? [
        { label: "Client", cell: (r) => r.clientId },
        { label: "Active", cell: (r) => r.active },
        { label: "Offline", cell: (r) => r.offline },
      ]
    : isSessionRows
      ? [
          { label: "User", cell: (r) => r.username },
          { label: "IP", cell: (r) => dash(r.ipAddress) },
          { label: "Started", cell: (r) => fmtTime(r.started) },
          { label: "Last access", cell: (r) => fmtTime(r.lastAccess) },
          { label: "Type", cell: (r) => (r.offline ? "offline" : "regular") },
        ]
      : cfg.columns;

  const rowActions: Act[] = isSessionStats
    ? [{ label: "Sessions", run: (r) => ctx.drill({ id: r.id, clientId: r.clientId }) }]
    : isSessionRows
      ? [
          { label: "Open user", run: (r) => openJson("user", r.username, ctx, r.userId, "$(user)") },
          {
            label: "Sign out",
            run: (r) =>
              void api("deleteSession", { realm, id: r.id, offline: r.offline }).then((x) => {
                say(x.ok ? "Session ended." : x.error, !x.ok);
                if (x.ok) void reload();
              }),
          },
        ]
      : acts;

  const applyFilters = () => {
    setFirst(0);
    setApplied(search);
    setAppliedFilters(Object.fromEntries(Object.entries(filters).filter(([, v]) => v)));
  };

  return (
    <div className="kc-page">
      <div className="kc-bar">
        <span className="kc-title">
          {cfg.title}
          {isSessionRows ? ` — ${drill?.clientId}` : ""}
        </span>
        <span className="kc-muted">{realm}</span>
        {isSessionRows && (
          <button className="oce-btn" onClick={() => ctx.drill(null)}>
            ← All clients
          </button>
        )}
        {cfg.searchable && (
          <input className="kc-input" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyFilters()} style={{ minWidth: 200 }} />
        )}
        {cfg.filters?.map((f) => (
          <input
            key={f.key}
            className="kc-input"
            type={f.type ?? "text"}
            title={f.label}
            placeholder={f.label}
            value={filters[f.key] ?? ""}
            onChange={(e) => setFilters({ ...filters, [f.key]: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && applyFilters()}
            style={{ width: f.type === "date" ? 140 : 170 }}
          />
        ))}
        {(cfg.searchable || cfg.filters) && (
          <button className="oce-btn" onClick={applyFilters}>
            {cfg.filters ? "Filter" : "Search"}
          </button>
        )}
        <span className="kc-spacer" />
        {eventsOn === false && (
          <button className="oce-btn" onClick={() => openResource(`Event settings — ${realm}`, { kind: "eventsConfig", realm }, "$(bell)")} title="Events are turned off for this realm">
            Enable events…
          </button>
        )}
        {(kind === "events" || kind === "adminEvents") && eventsOn && (
          <button className="oce-btn" onClick={() => openResource(`Event settings — ${realm}`, { kind: "eventsConfig", realm }, "$(bell)")}>
            Settings
          </button>
        )}
        {create && (
          <button className="oce-btn oce-btn-primary" onClick={create.run}>
            {create.label}
          </button>
        )}
        <button className="oce-btn" onClick={() => void reload()} disabled={loading}>
          Refresh
        </button>
      </div>

      <div className={selected ? "kc-body kc-split-v" : "kc-body"} style={selected ? { overflow: "hidden" } : undefined}>
        <div className="kc-table-wrap" style={{ minHeight: 0, overflow: "auto" }}>
          {error ? (
            <div className="kc-message kc-error">{error}</div>
          ) : !page ? (
            <div className="kc-message kc-muted">Loading…</div>
          ) : page.items.length === 0 ? (
            <div className="kc-message kc-muted">
              {loading ? "Loading…" : kind === "events" || kind === "adminEvents" ? (eventsOn === false ? "Events are turned off for this realm — enable them to start recording." : "No events match.") : "Nothing here."}
            </div>
          ) : (
            <table className="kc-table">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.label}>{c.label}</th>
                  ))}
                  {rowActions.length > 0 && <th />}
                </tr>
              </thead>
              <tbody>
                {page.items.map((row, i) => (
                  <tr key={cfg.key(row) + i} className={selected === row ? "kc-sel" : ""} onClick={() => (cfg.filters ? setSelected(selected === row ? null : row) : undefined)}>
                    {columns.map((c, ci) => (
                      <td key={c.label}>
                        {ci === 0 && cfg.openRow && !isSessionStats && !isSessionRows ? (
                          <button className="kc-link" onClick={() => cfg.openRow?.(row, ctx)}>
                            {c.cell(row)}
                          </button>
                        ) : (
                          c.cell(row)
                        )}
                      </td>
                    ))}
                    {rowActions.length > 0 && (
                      <td>
                        <div className="kc-actions">
                          {rowActions
                            .filter((a) => !a.show || a.show(row))
                            .map((a) => (
                              <button
                                key={a.label}
                                className="oce-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  a.run(row);
                                }}
                              >
                                {a.label}
                              </button>
                            ))}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {page && (first > 0 || page.hasMore) && (
            <div className="kc-row" style={{ padding: "10px 0" }}>
              <button className="oce-btn" disabled={first === 0 || loading} onClick={() => setFirst(Math.max(0, first - max))}>
                ← Previous
              </button>
              <span className="kc-muted">
                {first + 1}–{first + page.items.length}
                {page.total !== undefined ? ` of ${page.total}` : ""}
              </span>
              <button className="oce-btn" disabled={!page.hasMore || loading} onClick={() => setFirst(first + max)}>
                Next →
              </button>
            </div>
          )}
          {page && !(first > 0 || page.hasMore) && page.total !== undefined && page.items.length > 0 && <div className="kc-muted" style={{ padding: "8px 0" }}>{page.total} total</div>}
        </div>
        {selected && (
          <div className="kc-box" style={{ overflow: "auto" }}>
            <h4>
              <span>Details</span>
              <button className="kc-link" onClick={() => setSelected(null)}>
                close
              </button>
            </h4>
            <pre className="kc-pre">{JSON.stringify(selected, null, 2)}</pre>
          </div>
        )}
      </div>
      {dialog}
      {toast}
    </div>
  );
}
