import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { VIEWS, type View, type Workspace } from "./types";
import Dashboard from "./views/Dashboard";
import Tickets from "./views/Tickets";
import Terminal from "./views/Terminal";
import Agents from "./views/Agents";
import Stub from "./views/Stub";
import "./App.css";

// Convenience default for local dev; paste any workspace path.
const DEFAULT_PATH = "/Users/rengwu/Desktop/Projects/iudex-demo";

export default function App() {
  const [path, setPath] = useState(DEFAULT_PATH);
  const [root, setRoot] = useState<string | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string>("");
  const [view, setView] = useState<View>("dashboard");
  // Set when another view (an agent peek) asks Terminal to focus a session.
  const [focusSession, setFocusSession] = useState<string | null>(null);

  // The sole read path: re-run `iudex status --json` and replace local view.
  const load = useCallback(async (r: string) => {
    try {
      const data = await invoke<Workspace>("iudex_status", { root: r });
      setWs(data);
      setError(null);
      setLastSync(new Date().toLocaleTimeString());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  async function open() {
    try {
      const r = await invoke<string>("discover_workspace", { start: path });
      setRoot(r);
      await load(r);
      // Start the doorbell: any events.jsonl change triggers a re-read.
      await invoke("watch_workspace", { root: r });
    } catch (e) {
      setError(String(e));
      setRoot(null);
      setWs(null);
    }
  }

  // Subscribe once per workspace: the backend emits `events-changed`; we re-read.
  useEffect(() => {
    if (!root) return;
    const un = listen("events-changed", () => load(root));
    return () => {
      un.then((f) => f());
    };
  }, [root, load]);

  return (
    <main className="app">
      <header className="bar">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="path to an iudex workspace"
          spellCheck={false}
        />
        <button onClick={open}>Open</button>
        {ws && (
          <span className="meta">
            main: <b>{ws.mainBranch}</b> · max-active: <b>{ws.maxActive}</b> · qa-limit:{" "}
            <b>{ws.qaRejectLimit}</b>
            {lastSync && <span className="sync"> · synced {lastSync}</span>}
          </span>
        )}
      </header>

      {error && <div className="error">{error}</div>}

      {root && ws && (
        <>
          <nav className="nav">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                className={`nav-item${view === v.id ? " active" : ""}`}
                onClick={() => setView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </nav>

          <section className="view">
            {view === "dashboard" && <Dashboard ws={ws} onJump={setView} />}
            {view === "tickets" && <Tickets ws={ws} root={root} />}
            {/* Terminal stays mounted across view switches so its tabs and
                live PTYs survive; we only toggle its visibility. */}
            <div
              style={{ display: view === "terminal" ? "block" : "none" }}
              className="view-host"
            >
              <Terminal
                visible={view === "terminal"}
                focus={focusSession}
                onFocusHandled={() => setFocusSession(null)}
              />
            </div>
            {view === "agents" && (
              <Agents
                onOpenInTerminal={(name) => {
                  setFocusSession(name);
                  setView("terminal");
                }}
              />
            )}
            {view === "worktrees" && (
              <Stub
                title="Worktrees"
                blurb="Read-only, editor-style inspection of any ticket worktree — file tree, Monaco preview, and diff vs main."
              />
            )}
            {view === "review" && (
              <Stub
                title="Review"
                blurb="A deep-review workspace for pending-human-qa items: brief + QA review + diff, with a preflighted approve & merge."
              />
            )}
            {view === "settings" && (
              <Stub
                title="Settings"
                blurb="Edit config.yml fields and the impl/review prompt templates."
              />
            )}
          </section>
        </>
      )}
    </main>
  );
}
