import React from "react";
import ReactDOM from "react-dom/client";
import { GroupView } from "./Group.js";
import "@oneclient/editor-kit/theme.css";
import "@oneclient/editor-kit/editor.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <GroupView />
  </React.StrictMode>,
);
