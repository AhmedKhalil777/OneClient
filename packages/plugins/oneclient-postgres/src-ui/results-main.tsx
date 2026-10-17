import React from "react";
import ReactDOM from "react-dom/client";
import "@oneclient/editor-kit/theme.css";
import { ResultsPanel } from "./ResultsPanel.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ResultsPanel />
  </React.StrictMode>,
);
