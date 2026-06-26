import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { useSessions, sessionTitle, sessionLabel } from "../lib/sessions";
import { VIEWS, type Session } from "../types";
import XtermPane from "./XtermPane";
import ViewHeader from "../components/ViewHeader";
import Button from "../components/Button";
import s from "./Terminal.module.scss";

// Tab status-dot color by session kind/role (gui/design-system/README.md §4 — color is state).
function sessionDot(sessions: Session[], name: string): string {
  const x = sessions.find((s) => s.name === name);
  if (!x) return "#9ea0e0";
  if (x.kind === "idea") return "#e4e47a";
  if (x.kind === "shell") return "#9ea0e0";
  return x.role === "qa" ? "#836ddd" : "#5ccf5c";
}

// The interactive, full-size surface over the tmux pool. Each tab is a live
// attach to one session. Panes stay mounted once opened (hidden when inactive)
// so switching tabs never tears down a terminal. `focus` lets another view
// (Agents "open in Terminal") jump straight to a session's tab.
export default function Terminal({
  root,
  visible,
  focus,
  onFocusHandled,
}: {
  root: string;
  visible: boolean;
  focus?: string | null;
  onFocusHandled?: () => void;
}) {
  const { sessions, available, loaded } = useSessions();
  const [open, setOpen] = useState<string[]>([]); // sessions with a mounted pane
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openSession = (name: string) => {
    setOpen((o) => (o.includes(name) ? o : [...o, name]));
    setActiveTab(name);
  };

  // Tabs are in-GUI state that starts empty each launch, but the tmux pool is
  // detached and survives a GUI restart. Re-attach the surviving shells as tabs
  // once, on first load, so the view reflects the live pool (agents have their
  // own view, so they're left to be opened on demand via `focus`). Once-only so
  // closing a tab stays closed for the rest of the session.
  useEffect(() => {
    if (!loaded || restored) return;
    const shells = sessions.filter((x) => x.kind !== "agent").map((x) => x.name);
    if (shells.length > 0) {
      setOpen((o) => Array.from(new Set([...o, ...shells])));
      setActiveTab((t) => t ?? shells[0]);
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, restored]);

  // Honor an external focus request (e.g. clicking an agent peek).
  useEffect(() => {
    if (!focus) return;
    openSession(focus);
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // Drop tabs whose session vanished; keep activeTab valid. Guard on `loaded`
  // so a not-yet-polled empty list never wipes a freshly focused tab.
  const liveNames = sessions.map((s) => s.name);
  useEffect(() => {
    if (!loaded) return;
    setOpen((o) => o.filter((n) => liveNames.includes(n)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveNames.join(","), loaded]);
  useEffect(() => {
    if (!loaded) return;
    if (activeTab && !liveNames.includes(activeTab)) {
      setActiveTab(open[0] ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveNames.join(","), open.join(","), loaded]);

  const newShell = async () => {
    try {
      const s = await api.createShell(root);
      openSession(s.name);
    } catch (e) {
      setError(String(e));
    }
  };

  const kill = async (name: string) => {
    try {
      await api.killSession(name);
      setOpen((o) => o.filter((n) => n !== name));
    } catch (e) {
      setError(String(e));
    }
  };

  if (available === false) {
    return (
      <div className="stub">
        <h2>Terminal</h2>
        <p>
          tmux isn't on PATH. The terminal pool is tmux-backed (so agent
          sessions survive a GUI restart). Install it with{" "}
          <code>brew install tmux</code> and reopen this view.
        </p>
      </div>
    );
  }

  return (
    <div className={s.term}>
      <ViewHeader dot={VIEWS.terminal.dot} title="Terminal">
        <Button variant="secondary" size="sm" onClick={newShell}>
          + New Shell
        </Button>
      </ViewHeader>

      <div className={s.tabs}>
        {open.map((name) => (
          <div
            key={name}
            className={`${s.tab} ${activeTab === name ? s.active : ""}`}
            onClick={() => setActiveTab(name)}
          >
            <span
              className={s.tabDot}
              style={{ background: sessionDot(sessions, name) }}
            />
            <span>{tabLabel(sessions, name)}</span>
            <button
              className={s.x}
              title="kill session"
              onClick={(e) => {
                e.stopPropagation();
                kill(name);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {open.length === 0 ? (
        <div className={s.empty}>start a shell with “+ shell”.</div>
      ) : (
        <div className={s.panes}>
          {open.map((name) => (
            <div
              key={name}
              className={s.pane}
              style={{ display: activeTab === name ? "block" : "none" }}
            >
              <XtermPane
                session={name}
                active={visible && activeTab === name}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Tab label: prefer the session's metadata-derived label (ticket · role for
// agents); fall back to the name for a session not yet in the polled list.
function tabLabel(sessions: Session[], name: string): string {
  const s = sessions.find((x) => x.name === name);
  return s ? sessionLabel(s) : sessionTitle(name);
}
