import React from "react";
import ReactDOM from "react-dom/client";
import { Faker } from "./Faker.js";
import "@oneclient/editor-kit/theme.css";
import "@oneclient/sql-core/ui/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Faker />
  </React.StrictMode>,
);
