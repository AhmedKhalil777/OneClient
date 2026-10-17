import type { CommandHandler, TreeNode } from "@oneclient/plugin-api";
import { type ApiResult, callApi } from "./api.js";
import { requireClient } from "./sessions.js";

type Args = { connectionId: string; realm?: string; groupId?: string; node?: TreeNode } & Record<string, unknown>;

const RESOURCE = "keycloak.resource";

/**
 * Core opens a returned `openNode`'s view as a tab (the same convention as the SQL "New Query" command),
 * so a command can finish by showing the thing it just created.
 */
function editorTab(title: string, icon: string, params: Record<string, string>): TreeNode {
  return {
    id: `${title}:${Date.now()}`,
    label: title,
    nodeType: "keycloak.editor",
    collapsible: "none",
    openView: { viewId: RESOURCE, title, params, icon },
  };
}

type Outcome = { ok: true; openNode?: TreeNode } | { ok: false; error: string };

async function run(args: Args, method: string, params: Record<string, unknown>): Promise<ApiResult> {
  return callApi(requireClient(args.connectionId), method, params);
}

const fail = (r: ApiResult): Outcome => (r.ok ? { ok: true } : { ok: false, error: r.error });

function need(args: Args, key: "realm"): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`Missing ${key}.`);
  return v;
}

async function guarded(fn: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** One handler per context-menu command; each is declared (with its `when`) in the manifest. */
export function createCommandHandlers(): CommandHandler[] {
  const on = (commandId: string, fn: (args: Args) => Promise<Outcome>): CommandHandler => ({
    commandId,
    execute: (args) => guarded(() => fn((args[0] ?? {}) as Args)),
  });

  const cache = (which: "realm" | "user" | "keys") => async (a: Args) => fail(await run(a, "clearCache", { realm: need(a, "realm"), which }));

  return [
    // The one command views use for everything else (see api.ts).
    {
      commandId: "keycloak.api",
      async execute(args) {
        const a = (args[0] ?? {}) as { connectionId?: string; method?: string; params?: Record<string, unknown> };
        try {
          return await callApi(requireClient(a.connectionId), String(a.method ?? ""), a.params ?? {});
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ApiResult;
        }
      },
    },

    // -- connection
    on("keycloak.newRealm", async () => ({ ok: true, openNode: editorTab("New Realm", "$(cube)", { kind: "realm", mode: "create", realm: "" }) })),

    // -- realm
    on("keycloak.openRealm", async (a) => ({ ok: true, openNode: editorTab(`${need(a, "realm")} — Realm`, "$(cube)", { kind: "realm", realm: need(a, "realm"), id: need(a, "realm") }) })),
    on("keycloak.exportRealm", async (a) => ({ ok: true, openNode: editorTab(`Export — ${need(a, "realm")}`, "$(cube)", { kind: "export", realm: need(a, "realm"), doc: "1" }) })),
    on("keycloak.clearRealmCache", cache("realm")),
    on("keycloak.clearUserCache", cache("user")),
    on("keycloak.clearKeysCache", cache("keys")),
    on("keycloak.logoutAll", async (a) => fail(await run(a, "logoutAll", { realm: need(a, "realm") }))),
    on("keycloak.deleteRealm", async (a) => fail(await run(a, "remove", { kind: "realm", id: need(a, "realm"), realm: need(a, "realm") }))),

    // -- users / roles / clients / scopes / identity providers
    on("keycloak.newUser", async (a) => {
      const r = await run(a, "createUser", { ...a, realm: need(a, "realm") });
      if (!r.ok) return fail(r);
      const id = (r.data as { id: string }).id;
      return { ok: true, openNode: editorTab(`${String(a.username)} — User`, "$(user)", { kind: "user", realm: need(a, "realm"), id }) };
    }),
    on("keycloak.newRole", async (a) => {
      const realm = need(a, "realm");
      const name = String(a.name ?? "");
      const r = await run(a, "save", { kind: "role", realm, body: { name, ...(a.description ? { description: String(a.description) } : {}) } });
      if (!r.ok) return fail(r);
      return { ok: true, openNode: editorTab(`${name} — Role`, "$(tag)", { kind: "role", realm, id: name }) };
    }),
    on("keycloak.newClient", async (a) => ({ ok: true, openNode: editorTab("New Client", "$(window)", { kind: "client", mode: "create", realm: need(a, "realm") }) })),
    on("keycloak.newClientScope", async (a) => ({ ok: true, openNode: editorTab("New Client Scope", "$(symbol)", { kind: "clientScope", mode: "create", realm: need(a, "realm") }) })),
    on("keycloak.newIdentityProvider", async (a) => ({ ok: true, openNode: editorTab("New Identity Provider", "$(link)", { kind: "identityProvider", mode: "create", realm: need(a, "realm") }) })),

    // -- groups
    on("keycloak.newGroup", async (a) => {
      const r = await run(a, "save", { kind: "group", realm: need(a, "realm"), ...(a.groupId ? { parent: a.groupId } : {}), body: { name: String(a.name ?? "") } });
      return fail(r);
    }),
    on("keycloak.deleteGroup", async (a) => fail(await run(a, "remove", { kind: "group", realm: need(a, "realm"), id: String(a.groupId ?? "") }))),
  ];
}
