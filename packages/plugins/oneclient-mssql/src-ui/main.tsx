import React from "react";
import ReactDOM from "react-dom/client";
import { QueryWindow } from "./QueryWindow.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryWindow />
  </React.StrictMode>,
);
