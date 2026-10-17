import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import { TerminalPanel } from "./TerminalPanel.js";
import "@oneclient/editor-kit/theme.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

// No StrictMode: its double-mounting would open every xterm instance twice.
ReactDOM.createRoot(root).render(<TerminalPanel />);
