import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import type { Session, Workspace } from "../types";

// The opt-in automation engine: drain ready→active tickets (spawning impl agents)
// and spawn QA agents for pending-qa tickets. Both toggles default to off and
// are never persisted — switching workspaces resets them to off. The judgment
// gates (finish, qa verdict, human-qa merge) stay human — this only does the
// frictionless, surface-and-spawn steps.
//
// Inputs are the live workspace truth (root/ws/sessions) plus load() to re-read
// and onError() to surface failures; the hook owns the toggle state, the
// dedupe/guard refs, and the steady-cadence poll.
export function useAutomation(
  root: string | null,
  ws: Workspace | null,
  sessions: Session[],
  load: (r: string) => Promise<void>,
  onError: (msg: string) => void,
) {
  const [autoActivate, setAutoActivate] = useState(false);
  const autoActivateRef = useRef(false);
  const drainingRef = useRef(false);
  const skipRef = useRef<Set<string>>(new Set()); // ids whose activate/spawn failed — parked
  const [autoQA, setAutoQA] = useState(false);
  const autoQARef = useRef(false);
  const qaDrainingRef = useRef(false);
  const qaHandledRef = useRef<Set<string>>(new Set()); // pending-qa ids already spawned this episode

  // Reset both toggles to off when the workspace changes; reset the guards.
  useEffect(() => {
    if (!root) return;
    skipRef.current.clear();
    qaHandledRef.current.clear();
    autoActivateRef.current = false;
    autoQARef.current = false;
    setAutoActivate(false);
    setAutoQA(false);
  }, [root]);

  const toggleAutoActivate = useCallback((v: boolean) => {
    autoActivateRef.current = v;
    skipRef.current.clear();
    setAutoActivate(v);
  }, []);

  const toggleAutoQA = useCallback((v: boolean) => {
    autoQARef.current = v;
    qaHandledRef.current.clear();
    setAutoQA(v);
  }, []);

  // Auto-activate: while on, activate the first ready ticket + spawn its impl
  // agent, re-reading status each pass so deps + max_active stay current.
  useEffect(() => {
    if (!autoActivate || !root || !ws) return;
    if (drainingRef.current) return;
    if (!ws.tickets.some((t) => t.state === "queued" && t.ready)) return;
    drainingRef.current = true;
    (async () => {
      try {
        while (autoActivateRef.current) {
          const data = await api.iudexStatus(root);
          const next = data.tickets.find(
            (t) =>
              t.state === "queued" && t.ready && !skipRef.current.has(t.id),
          );
          if (!next) break;
          try {
            await api.runIudex(root, ["activate", next.id]);
            await api.spawnAgent(root, next.id, "impl");
          } catch (e) {
            skipRef.current.add(next.id);
            onError(String(e));
          }
        }
      } finally {
        drainingRef.current = false;
        load(root);
      }
    })();
  }, [autoActivate, root, ws, load, onError]);

  // Auto-QA: while on, spawn one QA agent per pending-qa ticket (the agent runs
  // its own verdict). Spawning doesn't change state, so guard per episode:
  // handled once, cleared when the ticket leaves pending-qa, skipped if a live
  // QA session already exists.
  useEffect(() => {
    if (!autoQA || !root || !ws) return;
    const pendingQA = new Set(
      ws.tickets.filter((t) => t.state === "pending-qa").map((t) => t.id),
    );
    for (const id of qaHandledRef.current) {
      if (!pendingQA.has(id)) qaHandledRef.current.delete(id);
    }
    const candidates = [...pendingQA].filter(
      (id) => !qaHandledRef.current.has(id),
    );
    if (candidates.length === 0 || qaDrainingRef.current) return;
    qaDrainingRef.current = true;
    (async () => {
      try {
        for (const id of candidates) {
          if (!autoQARef.current) break;
          const qaSessions = sessions.filter(
            (s) => s.kind === "agent" && s.role === "qa" && s.ticket === id,
          );
          let live = false;
          for (const s of qaSessions) {
            try {
              const st = await api.sessionStatus(s.name);
              if (!st.dead) {
                live = true;
                break;
              }
            } catch {
              // unknown → treat as not-live
            }
          }
          qaHandledRef.current.add(id);
          if (live) continue;
          try {
            await api.spawnAgent(root, id, "qa");
          } catch (e) {
            onError(String(e));
          }
        }
      } finally {
        qaDrainingRef.current = false;
      }
    })();
  }, [autoQA, root, ws, sessions, onError]);

  // While either automation is on, poll the workspace every 5s so the drains
  // re-evaluate on a steady cadence (not only on the events doorbell) — freeing
  // slots / newly-queued / newly-pending-qa tickets get picked up.
  useEffect(() => {
    if (!root || (!autoActivate && !autoQA)) return;
    const h = setInterval(() => load(root), 5000);
    return () => clearInterval(h);
  }, [autoActivate, autoQA, root, load]);

  return { autoActivate, autoQA, toggleAutoActivate, toggleAutoQA };
}
