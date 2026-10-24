import { useEffect, useState } from "react";
import { ErDiagram } from "./ErDiagram.js";
import type { ErModel, ErTable } from "./model.js";

export interface DiagramPageProps {
  /** The plugin's command returning the ErModel for `{ connectionId, database, schema }`. */
  modelCommand: string;
  /** The plugin's query-window view, opened on double-click with `rowsSql(table)`. */
  queryView: string;
  rowsSql: (table: ErTable) => string;
}

/**
 * The whole diagram tab of a SQL plugin: reads `connectionId`, `database`, `schema` and `focus` from its URL, asks the
 * plugin's backend for the model and draws it. Double-clicking a table opens its first rows in a query window.
 */
export function DiagramPage({ modelCommand, queryView, rowsSql }: DiagramPageProps) {
  const params = new URLSearchParams(location.search);
  const connectionId = params.get("connectionId") ?? "";
  const database = params.get("database") ?? "";
  const schema = params.get("schema") ?? "";
  const focus = params.get("focus") ?? undefined;
  const [model, setModel] = useState<ErModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    window.oneclientView
      .invokeCommand(modelCommand, [{ connectionId, database, ...(schema ? { schema } : {}) }])
      .then((m) => !cancelled && setModel(m as ErModel))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(err)));
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (error) return <div className="erd-page-message erd-error">Couldn't read the schema: {error}</div>;
  if (!model) return <div className="erd-page-message">Reading the schema…</div>;
  return (
    <ErDiagram
      key={version}
      model={model}
      storageKey={`${connectionId}/${database}/${schema || "*"}`}
      focus={focus}
      onReload={() => {
        setModel(null);
        setVersion((v) => v + 1);
      }}
      onOpenTable={(t) => {
        const title = `${t.name}.sql`;
        window.oneclientView.openView({ viewId: queryView, title, params: { windowId: `q${Date.now()}`, database, sql: rowsSql(t), autorun: "1", title } });
      }}
    />
  );
}
