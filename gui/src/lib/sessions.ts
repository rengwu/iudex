import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../types";

// Friendly label for a pool session, derived straight from its name (mirrors
// the backend's title format: iudex-shell-1 → "shell 1", iudex-agent-t3 →
// "agent t3"). Deriving it avoids waiting on the poll, so a fresh tab never
// flashes the raw session name before the friendly title arrives.
export function sessionTitle(name: string): string {
  const rest = name.replace(/^iudex-/, "");
  const dash = rest.indexOf("-");
  if (dash === -1) return name;
  return `${rest.slice(0, dash)} ${rest.slice(dash + 1)}`;
}

// Poll the tmux pool. Session membership changes on tmux commands the GUI
// doesn't route (a shell exiting, an agent dying), so unlike ticket state there
// is no doorbell — a light poll is the pragmatic source of truth here.
export function useSessions(pollMs = 2000) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false); // true after the first list
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    invoke<boolean>("tmux_available").then((a) => alive && setAvailable(a));

    const tick = async () => {
      try {
        const s = await invoke<Session[]>("list_sessions");
        if (alive) {
          setSessions(s);
          setLoaded(true);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    tick();
    const h = setInterval(tick, pollMs);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [pollMs]);

  return { sessions, available, loaded, error };
}
