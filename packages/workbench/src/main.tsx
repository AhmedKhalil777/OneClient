import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { ThemeProvider } from "./theme.js";
import "./styles.css";

async function start(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("#root element not found");

  // The desktop app's preload provides window.oneclient; in a browser it comes from the web server's socket.
  if (!(window as { oneclient?: unknown }).oneclient) {
    const { installWebBridge } = await import("./web/bridge.js");
    try {
      await installWebBridge();
    } catch (err) {
      root.innerHTML = `<div class="boot-error">Can't reach the oneClient server — ${err instanceof Error ? err.message : String(err)} <button onclick="location.reload()">Retry</button></div>`;
      return;
    }
  }

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </React.StrictMode>,
  );
}

void start();
