import { useSyncExternalStore } from "react";
import * as api from "./api";
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

// Friendly label for a session, used by both the Agents peeks and the Terminal
// tabs. Agents have opaque names, so their label comes from metadata (ticket ·
// role); shells fall back to the name-derived title.
export function sessionLabel(s: Session): string {
  if (s.kind === "agent") {
    const ticket = s.ticket ?? "agent";
    return s.role ? `${ticket} · ${s.role}` : ticket;
  }
  if (s.kind === "idea") {
    return s.role ? `idea: ${s.role}` : "idea";
  }
  return sessionTitle(s.name);
}

// ── Shared sessions store ────────────────────────────────────────────────────
// The tmux pool has no doorbell (sessions appear/die on commands the GUI doesn't
// route), so it needs polling. Every view that needs the session list wants the
// identical data, so one shared poll fans out to all of them instead of each
// spinning its own timer. Mirrors the useSyncExternalStore idiom in diffView.ts,
// extended with a ref-counted timer that:
//   - polls only while ≥1 component subscribes,
//   - pauses while the window is hidden (and refreshes the moment it returns),
//   - notifies subscribers only when the session list actually changes, so a
//     steady-state tick causes zero re-renders.

const POLL_MS = 2000;

type SessionsSnapshot = {
  sessions: Session[];
  available: boolean | null; // null until the one-time tmux_available check lands
  loaded: boolean; // true after the first list
  error: string | null;
};

// The cached snapshot. useSyncExternalStore requires getSnapshot to return a
// stable reference when nothing changed, so this object is replaced only when
// setSnapshot detects a real difference.
let snapshot: SessionsSnapshot = {
  sessions: [],
  available: null,
  loaded: false,
  error: null,
};

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function sessionsEqual(a: Session[], b: Session[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.name !== y.name ||
      x.kind !== y.kind ||
      x.ticket !== y.ticket ||
      x.role !== y.role ||
      x.started !== y.started ||
      x.title !== y.title
    ) {
      return false;
    }
  }
  return true;
}

// Apply a partial update; replace the snapshot + notify only if something truly
// differs. Otherwise keep the same identity so subscribers don't re-render.
function setSnapshot(patch: Partial<SessionsSnapshot>) {
  const next = { ...snapshot, ...patch };
  if (
    next.available === snapshot.available &&
    next.loaded === snapshot.loaded &&
    next.error === snapshot.error &&
    sessionsEqual(next.sessions, snapshot.sessions)
  ) {
    return;
  }
  snapshot = next;
  for (const l of listeners) l();
}

async function tick() {
  try {
    const s = await api.listSessions();
    setSnapshot({ sessions: s, loaded: true, error: null });
  } catch (e) {
    setSnapshot({ error: String(e) });
  }
}

function startPolling() {
  if (timer !== null) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  tick(); // immediate refresh on (re)start
  timer = setInterval(tick, POLL_MS);
}

function stopPolling() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function onVisibility() {
  if (document.visibilityState === "hidden") {
    stopPolling();
  } else if (listeners.size > 0) {
    startPolling(); // resume + immediate refresh
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    // First subscriber: one-time availability probe, watch visibility, start.
    api
      .tmuxAvailable()
      .then((a) => setSnapshot({ available: a }))
      .catch(() => setSnapshot({ available: false }));
    document.addEventListener("visibilitychange", onVisibility);
    startPolling();
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}

function getSnapshot(): SessionsSnapshot {
  return snapshot;
}

// Subscribe to the shared tmux session pool. Every caller gets the same live
// snapshot from a single poll. Drop-in replacement for the old per-instance hook
// (same return shape) — the five call sites are unchanged.
export function useSessions(): SessionsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}
