import { useCallback, useEffect, useState } from "react";
import { FormDialog, api, fmtNum, open, useToast } from "./kit.js";

interface Overview {
  clusterId: string;
  controller: number | null;
  brokers: Array<{ nodeId: number; host: string; port: number; controller: boolean }>;
  topics: number;
  partitions: number;
  underReplicated: number;
}
interface TopicRow {
  name: string;
  internal: boolean;
  partitions: number;
  replicationFactor: number;
  underReplicated: number;
}
interface GroupRow {
  groupId: string;
  state: string;
  protocolType: string;
  members: number;
}

const openTopic = (topic: string) => open("kafka.topic", topic, { topic }, "$(list-unordered)");
const openGroup = (groupId: string) => open("kafka.group", groupId, { groupId }, "$(organization)");

/** Cluster dashboard: brokers, every topic and every consumer group at a glance. */
export function ClusterView() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [topics, setTopics] = useState<TopicRow[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [internal, setInternal] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<React.ReactNode>(null);
  const [toast, say] = useToast();

  const load = useCallback(async () => {
    const [o, t, g] = await Promise.all([api<Overview>("cluster"), api<TopicRow[]>("topics", { internal }), api<GroupRow[]>("groups")]);
    const err = [o, t, g].find((r) => !r.ok);
    setError(err && !err.ok ? err.error : "");
    if (o.ok) setOverview(o.data);
    if (t.ok) setTopics(t.data);
    if (g.ok) setGroups(g.data);
  }, [internal]);
  useEffect(() => void load(), [load]);

  const q = filter.trim().toLowerCase();
  const newTopic = () =>
    setDialog(
      <FormDialog
        title="New topic"
        fields={[
          { key: "name", label: "Name (letters, digits, '.', '_', '-')", required: true },
          { key: "partitions", label: "Partitions", required: true, value: "1" },
          { key: "replicationFactor", label: `Replication factor (≤ ${overview?.brokers.length ?? 1} brokers)`, required: true, value: "1" },
        ]}
        submitLabel="Create"
        onClose={() => setDialog(null)}
        onSubmit={async (v) => {
          const name = String(v.name).trim();
          const r = await api("createTopic", { name, partitions: Number(v.partitions), replicationFactor: Number(v.replicationFactor) });
          if (!r.ok) return r.error;
          say(`Topic ${name} created.`);
          window.oneclientView.refreshExplorer?.();
          openTopic(name);
          await load();
        }}
      />,
    );

  return (
    <div className="kc-page">
      <div className="kc-bar">
        <span className="kc-title">Kafka cluster</span>
        {overview && <span className="kc-muted kf-mono">{overview.clusterId}</span>}
        <span className="kc-spacer" />
        <input className="kc-input" placeholder="Filter topics and groups" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="oce-btn" onClick={newTopic}>
          New topic…
        </button>
        <button className="oce-btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <div className="kc-body">
        {error && <div className="kc-error">{error}</div>}
        {overview && (
          <div className="kf-cards">
            <div className="kf-card">
              <div className="l">Brokers</div>
              <div className="v">{overview.brokers.length}</div>
            </div>
            <div className="kf-card">
              <div className="l">Topics</div>
              <div className="v">{fmtNum(overview.topics)}</div>
            </div>
            <div className="kf-card">
              <div className="l">Partitions</div>
              <div className="v">{fmtNum(overview.partitions)}</div>
            </div>
            <div className="kf-card">
              <div className="l">Under-replicated</div>
              <div className={`v${overview.underReplicated ? " warn" : ""}`}>{overview.underReplicated}</div>
            </div>
            <div className="kf-card">
              <div className="l">Consumer groups</div>
              <div className="v">{groups.length}</div>
            </div>
          </div>
        )}

        <h2 className="kc-h">Brokers</h2>
        <table className="kc-table">
          <thead>
            <tr>
              <th className="kf-num">Id</th>
              <th>Host</th>
              <th className="kf-num">Port</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {overview?.brokers.map((b) => (
              <tr key={b.nodeId}>
                <td className="kf-num">{b.nodeId}</td>
                <td>{b.host}</td>
                <td className="kf-num">{b.port}</td>
                <td>{b.controller ? <span className="kc-badge">controller</span> : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className="kc-h kc-row">
          Topics
          <label className="kc-row kc-muted" style={{ gap: 4, fontWeight: 400 }}>
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Show internal
          </label>
        </h2>
        {topics.length === 0 ? (
          <div className="kc-muted">No topics yet.</div>
        ) : (
          <table className="kc-table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="kf-num">Partitions</th>
                <th className="kf-num">Replication</th>
                <th>Health</th>
              </tr>
            </thead>
            <tbody>
              {topics
                .filter((t) => t.name.toLowerCase().includes(q))
                .map((t) => (
                  <tr key={t.name}>
                    <td>
                      <button className="kc-link" onClick={() => openTopic(t.name)}>
                        {t.name}
                      </button>
                      {t.internal && <span className="kc-badge off" style={{ marginLeft: 6 }}>internal</span>}
                    </td>
                    <td className="kf-num">{t.partitions}</td>
                    <td className="kf-num">{t.replicationFactor}</td>
                    <td className={t.underReplicated ? "warn" : "kc-ok"}>{t.underReplicated ? `${t.underReplicated} under-replicated` : "OK"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}

        <h2 className="kc-h">Consumer groups</h2>
        {groups.length === 0 ? (
          <div className="kc-muted">No consumer groups.</div>
        ) : (
          <table className="kc-table">
            <thead>
              <tr>
                <th>Group</th>
                <th>State</th>
                <th className="kf-num">Members</th>
              </tr>
            </thead>
            <tbody>
              {groups
                .filter((g) => g.groupId.toLowerCase().includes(q))
                .map((g) => (
                  <tr key={g.groupId}>
                    <td>
                      <button className="kc-link" onClick={() => openGroup(g.groupId)}>
                        {g.groupId}
                      </button>
                    </td>
                    <td>
                      <span className={`kc-badge${g.state === "Stable" ? "" : " off"}`}>{g.state}</span>
                    </td>
                    <td className="kf-num">{g.members}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
      {dialog}
      {toast}
    </div>
  );
}
