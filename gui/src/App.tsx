import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

// Mirrors the `iudex status --json` contract. The GUI holds no authoritative
// state of its own; every field here comes from replaying events.jsonl in the
// CLI, surfaced through that one read path.
interface Ticket {
  id: string;
  state: string;
  deps: string[];
  qaRejects: number;
  ready: boolean;
  blockedBy: string[];
  hasWorktree: boolean;
  worktree?: string;
}

interface Workspace {
  mainBranch: string;
  maxActive: number;
  qaRejectLimit: number;
  tickets: Ticket[];
}

// Convenience default for local dev; paste any workspace path.
const DEFAULT_PATH = "/Users/rengwu/Desktop/Projects/iudex-demo";

function detail(t: Ticket): string {
  if (t.state === "queued") {
    return t.ready ? "ready" : `blocked by ${t.blockedBy.join(", ")}`;
  }
  if (t.hasWorktree && t.worktree) return t.worktree;
  return "";
}

export default function App() {
  const [path, setPath] = useState(DEFAULT_PATH);
  const [root, setRoot] = useState<string | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string>("");

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
        <table className="tickets">
          <thead>
            <tr>
              <th>id</th>
              <th>state</th>
              <th>qa rejects</th>
              <th>detail</th>
            </tr>
          </thead>
          <tbody>
            {ws.tickets.length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  no tickets yet
                </td>
              </tr>
            )}
            {ws.tickets.map((t) => (
              <tr key={t.id}>
                <td className="id">{t.id}</td>
                <td>
                  <span className={`state state-${t.state}`}>{t.state}</span>
                </td>
                <td className="num">{t.qaRejects || ""}</td>
                <td className="muted">{detail(t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
