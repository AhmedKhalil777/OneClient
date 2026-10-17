import { useCallback, useEffect, useState } from "react";
import { FeatureEditor } from "@oneclient/editor-kit/editor";
import { ConfirmDialog, FormDialog, Modal, type Json, api, copy, open, openResource, qs, useToast } from "./kit.js";

const DOC_KINDS = ["serverInfo", "wellKnown", "jwks", "installation", "export", "eventsConfig", "credentials", "serviceAccount"];

const TEMPLATES: Record<string, Json> = {
  realm: { realm: "", displayName: "", enabled: true },
  user: { username: "", email: "", firstName: "", lastName: "", enabled: true },
  client: { clientId: "", name: "", protocol: "openid-connect", enabled: true, publicClient: true, standardFlowEnabled: true, redirectUris: ["*"], webOrigins: ["+"] },
  role: { name: "", description: "" },
  clientRole: { name: "", description: "" },
  group: { name: "" },
  clientScope: { name: "", protocol: "openid-connect", attributes: { "include.in.token.scope": "true", "display.on.consent.screen": "true" } },
  identityProvider: { alias: "", providerId: "oidc", enabled: true, config: {} },
};

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready" };

/** JSON editor for one Keycloak resource (user, client, role, …) or document (server info, installation config, …). */
export function Resource() {
  const kind = qs.get("kind") ?? "";
  const realm = qs.get("realm") ?? "";
  const parent = qs.get("parent") ?? undefined;
  const isDoc = DOC_KINDS.includes(kind);

  const [id, setId] = useState(qs.get("id") ?? "");
  const [creating, setCreating] = useState(qs.get("mode") === "create");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [text, setText] = useState("");
  const [saved, setSaved] = useState("");
  const [readOnly, setReadOnly] = useState(isDoc);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<React.ReactNode>(null);
  const [toast, say] = useToast();

  const dirty = state.kind === "ready" && text !== saved;
  const pretty = (v: unknown) => JSON.stringify(v, null, 2);

  const load = useCallback(async () => {
    if (creating) {
      const t = pretty(TEMPLATES[kind] ?? {});
      setText(t);
      setSaved(t);
      setReadOnly(false);
      setState({ kind: "ready" });
      return;
    }
    setState({ kind: "loading" });
    const r = isDoc
      ? await api<{ doc: unknown; editable: boolean }>("document", { kind, realm, id })
      : await api<{ doc: unknown; readOnly: boolean }>("get", { kind, realm, id, parent });
    if (!r.ok) return setState({ kind: "error", message: r.error });
    const t = pretty(r.data.doc);
    setText(t);
    setSaved(t);
    setReadOnly(isDoc ? !(r.data as { editable: boolean }).editable : (r.data as { readOnly: boolean }).readOnly);
    setState({ kind: "ready" });
  }, [creating, kind, realm, id, parent, isDoc]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    window.oneclientView.setDirty(dirty);
  }, [dirty]);

  const save = async () => {
    if (readOnly || busy) return;
    setBusy(true);
    const r = isDoc ? await api("saveDocument", { kind, realm, id, body: text }) : await api<{ id: string }>("save", { kind, realm, parent, id: creating ? undefined : id, body: text });
    setBusy(false);
    if (!r.ok) return say(r.error, true);
    if (!isDoc && creating) {
      setCreating(false);
      setId((r.data as { id: string }).id);
      say("Created.");
    } else {
      say("Saved.");
      setSaved(text);
      if (!isDoc) void load();
    }
  };

  const remove = () =>
    setDialog(
      <ConfirmDialog
        title={`Delete ${kind}`}
        text={`Delete this ${kind}${id ? ` (${id})` : ""}? This cannot be undone.`}
        onClose={() => setDialog(null)}
        onConfirm={async () => {
          const r = await api("remove", { kind, realm, parent, id });
          if (!r.ok) return say(r.error, true);
          setSaved(text);
          setState({ kind: "error", message: "Deleted. You can close this tab." });
        }}
      />,
    );

  const secret = async (regenerate: boolean) => {
    const r = await api<{ value?: string }>("secret", { realm, id, regenerate });
    if (!r.ok) return say(r.error, true);
    const value = r.data.value ?? "";
    setDialog(
      <Modal title={`Client secret${regenerate ? " (regenerated)" : ""}`} onClose={() => setDialog(null)}>
        {value ? <pre className="kc-pre">{value}</pre> : <div className="kc-muted">This client has no secret (public client).</div>}
        <div className="kc-row" style={{ justifyContent: "flex-end" }}>
          {value && (
            <button className="oce-btn" onClick={async () => say((await copy(value)) ? "Copied." : "Couldn't copy.")}>
              Copy
            </button>
          )}
          <button className="oce-btn" onClick={() => void secret(true)}>
            Regenerate
          </button>
          <button className="oce-btn oce-btn-primary" onClick={() => setDialog(null)}>
            Close
          </button>
        </div>
      </Modal>,
    );
  };

  const resetPassword = () =>
    setDialog(
      <FormDialog
        title="Reset password"
        submitLabel="Reset"
        fields={[
          { key: "password", label: "New password", type: "password", required: true },
          { key: "temporary", label: "Require change at next login", type: "checkbox" },
        ]}
        onClose={() => setDialog(null)}
        onSubmit={async (v) => {
          const r = await api("resetPassword", { realm, id, password: v.password, temporary: v.temporary });
          if (!r.ok) return r.error;
          say("Password reset.");
        }}
      />,
    );

  const mappings = (subject: "user" | "group") => open("keycloak.mappings", `Access — ${displayName()}`, { subject, id, realm, name: displayName() }, "$(shield)");
  const displayName = () => {
    try {
      const o = JSON.parse(text) as Json;
      return String(o.username ?? o.name ?? o.clientId ?? o.alias ?? o.realm ?? id);
    } catch {
      return id;
    }
  };

  const extra = !creating && !isDoc && id ? (
    <>
      {kind === "user" && (
        <>
          <button className="oce-btn" onClick={resetPassword}>Reset password</button>
          <button className="oce-btn" onClick={() => mappings("user")}>Roles &amp; groups</button>
          <button className="oce-btn" onClick={() => openResource(`Credentials — ${displayName()}`, { kind: "credentials", realm, id }, "$(lock)")}>Credentials</button>
        </>
      )}
      {kind === "group" && (
        <button className="oce-btn" onClick={() => mappings("group")}>Role mappings</button>
      )}
      {kind === "client" && (
        <>
          <button className="oce-btn" onClick={() => void secret(false)}>Secret</button>
          <button className="oce-btn" onClick={() => openResource(`Installation — ${displayName()}`, { kind: "installation", realm, id }, "$(file-code)")}>Installation</button>
          <button className="oce-btn" onClick={() => openResource(`Service account — ${displayName()}`, { kind: "serviceAccount", realm, id }, "$(user)")}>Service account</button>
          <button className="oce-btn" onClick={() => open("keycloak.table", `Roles — ${displayName()}`, { kind: "clientRole", realm, parent: id }, "$(tag)")}>Client roles</button>
        </>
      )}
      {kind === "realm" && (
        <button className="oce-btn" onClick={() => openResource(`Export — ${realm || id}`, { kind: "export", realm: realm || id }, "$(cube)")}>Export</button>
      )}
      {!readOnly && (
        <button className="oce-btn" onClick={remove}>Delete</button>
      )}
    </>
  ) : null;

  if (state.kind === "loading") return <div className="kc-message">Loading…</div>;
  if (state.kind === "error") {
    return (
      <div className="kc-message">
        <div className="kc-error">{state.message}</div>
        {!state.message.startsWith("Deleted") && (
          <button className="oce-btn" onClick={() => void load()}>
            Retry
          </button>
        )}
      </div>
    );
  }

  const title = creating ? `New ${kind}` : `${kind}${id ? `: ${id}` : ""}`;
  return (
    <div className="kc-page">
      <FeatureEditor
        value={text}
        onChange={setText}
        fileName={`${kind}.json`}
        displayPath={`${realm ? realm + " / " : ""}${title}`}
        indentSource={saved}
        readOnly={readOnly}
        onSave={() => void save()}
        toolbarStart={<strong>{title}</strong>}
        toolbarEnd={
          <>
            {extra}
            <button className="oce-btn" disabled={busy} onClick={() => void load()} title="Discard changes and reload">
              {dirty ? "Revert" : "Reload"}
            </button>
            {!readOnly && (
              <button className="oce-btn oce-btn-primary" disabled={busy || (!dirty && !creating)} onClick={() => void save()}>
                {creating ? "Create" : "Save"}
              </button>
            )}
          </>
        }
        status={readOnly ? <span className="kc-muted">Read-only</span> : undefined}
      />
      {dialog}
      {toast}
    </div>
  );
}
