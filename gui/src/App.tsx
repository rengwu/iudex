import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { VIEWS, type View, type Workspace } from "./types";
import Dashboard from "./views/Dashboard";
import Tickets from "./views/Tickets";
import Terminal from "./views/Terminal";
import Agents from "./views/Agents";
import Worktrees from "./views/Worktrees";
import Review from "./views/Review";
import Stub from "./views/Stub";
import "./App.css";

// Convenience default for local dev; paste any workspace path.
const DEFAULT_PATH = "/Users/rengwu/Desktop/Projects/iudex-demo";

export default function App() {
  const [path, setPath] = useState(DEFAULT_PATH);
  const [root, setRoot] = useState<string | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True when the typed path exists but holds no iudex workspace — we then offer
  // to initialize one there instead of just erroring.
  const [offerInit, setOfferInit] = useState(false);
  const [initing, setIniting] = useState(false);
  const [lastSync, setLastSync] = useState<string>("");
  const [view, setView] = useState<View>("dashboard");
  // Set when another view (an agent peek) asks Terminal to focus a session.
  const [focusSession, setFocusSession] = useState<string | null>(null);
  // Set when the Dashboard opens a specific ticket straight into Review.
  const [focusTicket, setFocusTicket] = useState<string | null>(null);

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

  // Wire up a resolved workspace root: read it and start the doorbell.
  const enter = useCallback(
    async (r: string) => {
      setRoot(r);
      setError(null);
      setOfferInit(false);
      await load(r);
      // Start the doorbell: any events.jsonl change triggers a re-read.
      await invoke("watch_workspace", { root: r });
    },
    [load]
  );

  async function open() {
    try {
      const r = await invoke<string>("discover_workspace", { start: path });
      await enter(r);
    } catch (e) {
      const msg = String(e);
      setRoot(null);
      setWs(null);
      // A resolvable folder with no workspace → offer to initialize one there;
      // anything else (e.g. a bad path) is a real error.
      if (msg.includes("not inside an iudex workspace")) {
        setOfferInit(true);
        setError(null);
      } else {
        setError(msg);
        setOfferInit(false);
      }
    }
  }

  async function initHere() {
    setIniting(true);
    try {
      const r = await invoke<string>("init_workspace", { path });
      await enter(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setIniting(false);
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
          onChange={(e) => {
            setPath(e.target.value);
            setOfferInit(false);
            setError(null);
          }}
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

      {offerInit && (
        <div className="init-offer">
          <div>
            No iudex workspace at <code>{path}</code>.
            <span className="init-hint">
              {" "}
              Initializing creates <code>.iudex/</code> here (and a git repo with an
              initial commit if there isn’t one).
            </span>
          </div>
          <button disabled={initing} onClick={initHere}>
            {initing ? "Initializing…" : "Initialize iudex here"}
          </button>
        </div>
      )}

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
            {view === "dashboard" && (
              <Dashboard
                ws={ws}
                onJump={setView}
                onOpenReview={(id) => {
                  setFocusTicket(id);
                  setView("review");
                }}
              />
            )}
            {view === "tickets" && (
              <Tickets
                ws={ws}
                root={root}
                onOpenInTerminal={(name) => {
                  setFocusSession(name);
                  setView("terminal");
                }}
              />
            )}
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
                ws={ws}
                onOpenInTerminal={(name) => {
                  setFocusSession(name);
                  setView("terminal");
                }}
              />
            )}
            {view === "worktrees" && (
              <Worktrees
                ws={ws}
                root={root}
                onOpenInTerminal={(name) => {
                  setFocusSession(name);
                  setView("terminal");
                }}
              />
            )}
            {view === "review" && (
              <Review
                ws={ws}
                root={root}
                focusTicket={focusTicket}
                onFocusHandled={() => setFocusTicket(null)}
                onOpenInTerminal={(name) => {
                  setFocusSession(name);
                  setView("terminal");
                }}
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
