import React from "react";
import ReactDOM from "react-dom/client";
import "@oneclient/editor-kit/theme.css";
import "@oneclient/editor-kit/erd.css";
import { DiagramPage } from "@oneclient/editor-kit/erd";

// The ER diagram tab of a database (SQL Server: Database Diagram).
const quote = (s: string) => `[${s.replace(/]/g, "]]")}]`;

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <DiagramPage modelCommand="mssql.erModel" queryView="mssql.query" rowsSql={(t) => `SELECT TOP (1000) *\n  FROM ${quote(t.schema)}.${quote(t.name)};`} />
  </React.StrictMode>,
);