import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { ThemeProvider } from "./theme.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
