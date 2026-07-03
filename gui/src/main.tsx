import React from "react";
import ReactDOM from "react-dom/client";
// IBM Plex — bundled (offline under Tauri CSP); the design lives near 11–13px so
// we load 400/500/600 (UI) and 400/500 (mono).
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import App from "./App";
import QuitGuard from "./components/QuitGuard";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <QuitGuard />
  </React.StrictMode>,
);
