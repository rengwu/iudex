import { useEffect, useSyncExternalStore } from "react";
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

// The workspace the shared poll is scoped to. `list_sessions` filters to this
// root in the backend, so switching workspaces shows only that project's
// sessions (set via useSessions). Null when no workspace is open → no poll.
let currentRoot: string | null = null;

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
      x.retireAt !== y.retireAt ||
      x.retirePardon !== y.retirePardon ||
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

// Optimistically add a just-created session so views that prune to / focus from
// the live list (the Terminal tabs) see it immediately, instead of dropping or
// un-focusing it during the up-to-POLL_MS gap before the next tick. The poll
// reconciles it shortly after (a no-op if identical). No-op if already present.
export function addSession(sx: Session) {
  if (snapshot.sessions.some((s) => s.name === sx.name)) return;
  setSnapshot({ sessions: [...snapshot.sessions, sx], loaded: true });
}

async function tick() {
  const root = currentRoot;
  if (!root) return; // no workspace open → nothing to poll
  try {
    const s = await api.listSessions(root);
    // Drop a late response from a previous workspace if root changed mid-flight.
    if (currentRoot !== root) return;
    setSnapshot({ sessions: s, loaded: true, error: null });
  } catch (e) {
    setSnapshot({ error: String(e) });
  }
}

// Point the shared poll at a workspace. On change, clear the previous
// workspace's sessions immediately (so they don't linger across a switch), then
// refetch for the new root.
function setCurrentRoot(root: string | null) {
  if (root === currentRoot) return;
  currentRoot = root;
  setSnapshot({ sessions: [], loaded: false });
  if (root && timer !== null) tick();
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

// Re-probe tmux availability and update the shared snapshot. Runs once when
// the first subscriber arrives; exported so onboarding can flip `available`
// the moment its tmux install succeeds (no app restart needed).
export function recheckTmux() {
  api
    .tmuxAvailable()
    .then((a) => setSnapshot({ available: a }))
    .catch(() => setSnapshot({ available: false }));
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    // First subscriber: one-time availability probe, watch visibility, start.
    recheckTmux();
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

// Subscribe to the shared tmux session pool, scoped to the open workspace.
// Every caller gets the same live snapshot from a single poll; passing `root`
// keeps that poll filtered to the current workspace (callers all pass the same
// open root, so it's idempotent). Null root (no workspace) yields an empty list.
export function useSessions(root: string | null): SessionsSnapshot {
  useEffect(() => {
    setCurrentRoot(root);
  }, [root]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
