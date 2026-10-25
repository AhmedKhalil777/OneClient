import React from "react";
import ReactDOM from "react-dom/client";
import { Aggregate } from "@oneclient/sql-core/ui";
import { postgresDialect } from "./dialect.js";
import "@oneclient/editor-kit/theme.css";
import "@oneclient/editor-kit/sql.css";
import "@oneclient/sql-core/ui/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Aggregate dialect={postgresDialect} />
  </React.StrictMode>,
);
