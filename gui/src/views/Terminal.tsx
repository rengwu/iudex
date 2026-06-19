import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessions, sessionTitle, sessionLabel } from "../lib/sessions";
import type { Session } from "../types";
import XtermPane from "./XtermPane";
import s from "./Terminal.module.scss";

// The interactive, full-size surface over the tmux pool. Each tab is a live
// attach to one session. Panes stay mounted once opened (hidden when inactive)
// so switching tabs never tears down a terminal. `focus` lets another view
// (Agents "open in Terminal") jump straight to a session's tab.
export default function Terminal({
  visible,
  focus,
  onFocusHandled,
}: {
  visible: boolean;
  focus?: string | null;
  onFocusHandled?: () => void;
}) {
  const { sessions, available, loaded } = useSessions();
  const [open, setOpen] = useState<string[]>([]); // sessions with a mounted pane
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openSession = (name: string) => {
    setOpen((o) => (o.includes(name) ? o : [...o, name]));
    setActiveTab(name);
  };

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
      const s = await invoke<{ name: string }>("create_shell");
      openSession(s.name);
    } catch (e) {
      setError(String(e));
    }
  };

  const kill = async (name: string) => {
    try {
      await invoke("kill_session", { name });
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
          tmux isn't on PATH. The terminal pool is tmux-backed (so agent sessions
          survive a GUI restart). Install it with <code>brew install tmux</code>{" "}
          and reopen this view.
        </p>
      </div>
    );
  }

  return (
    <div className={s.term}>
      <div className={s.tabs}>
        {open.map((name) => (
          <div
            key={name}
            className={`${s.tab} ${activeTab === name ? s.active : ""}`}
            onClick={() => setActiveTab(name)}
          >
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
        <button className={s.new} onClick={newShell}>
          + shell
        </button>
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
