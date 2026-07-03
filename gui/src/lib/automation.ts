import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import { IN_FLIGHT_STATES } from "./ticketActions";
import type { Session, Workspace } from "../types";

// The opt-in automation engine: drain ready→active tickets (spawning impl
// agents), respawn impl for tickets rejected back to active, and spawn QA
// agents for pending-qa tickets. The engine toggles default to off and are
// never persisted — switching workspaces resets them to off, so opening the
// app can never silently spend tokens. The judgment gates (finish, qa verdict,
// human-qa merge) stay human — this only does the frictionless,
// surface-and-spawn steps.
//
// Sequential mode is different in kind: a *policy*, not an engine switch — "at
// most one ticket in flight" (active | pending-qa | pending-human-qa; `failed`
// is a parked human decision, not flight). It is persisted per workspace
// (gui_sequential in .iudex/config.yml) and in force even with the engine off:
// the views' manual Activate honors it too (see ticketActions). Full design:
// .context/prd/sequential-mode.md.
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
  const [autoRetire, setAutoRetire] = useState(false);
  const retiredRef = useRef<Set<string>>(new Set()); // agent names already kill-requested
  const [sequential, setSequentialState] = useState(false);
  const sequentialRef = useRef(false);
  const implDrainingRef = useRef(false);
  const implHandledRef = useRef<Set<string>>(new Set()); // active ids whose impl spawn was issued this episode
  const [autoResolve, setAutoResolve] = useState(false);
  const autoResolveRef = useRef(false);
  const resolveDrainingRef = useRef(false);
  const resolveHandledRef = useRef<Set<string>>(new Set()); // pending-human-qa ids resolved this episode
  const autoBegunRef = useRef<Set<string>>(new Set()); // merges *we* began (vs the human's — hands off those)
  const doneCountRef = useRef(-1); // detects merges: done-count change ⇒ main moved ⇒ new episode
  const [resolveStatus, setResolveStatus] = useState<ResolveStatus | null>(null);

  // Sequential is persisted per workspace — load it whenever the root changes
  // (unlike the engine toggles below, which deliberately reset to off).
  useEffect(() => {
    if (!root) return;
    api
      .getSequential(root)
      .then((v) => {
        sequentialRef.current = v;
        setSequentialState(v);
      })
      .catch(() => {
        sequentialRef.current = false;
        setSequentialState(false);
      });
  }, [root]);

  const toggleSequential = useCallback(
    (v: boolean) => {
      if (!root) return;
      // Optimistic: the drain reads the ref; a failed write is surfaced and
      // re-synced from disk.
      sequentialRef.current = v;
      setSequentialState(v);
      api.setSequential(root, v).catch((e) => {
        onError(String(e));
        api.getSequential(root).then((cur) => {
          sequentialRef.current = cur;
          setSequentialState(cur);
        });
      });
    },
    [root, onError],
  );

  // Reset all engine toggles to off when the workspace changes; reset the
  // guards. (Sequential is a persisted policy — re-loaded above, not reset.)
  useEffect(() => {
    if (!root) return;
    skipRef.current.clear();
    qaHandledRef.current.clear();
    implHandledRef.current.clear();
    retiredRef.current.clear();
    resolveHandledRef.current.clear();
    autoBegunRef.current.clear();
    doneCountRef.current = -1;
    autoActivateRef.current = false;
    autoQARef.current = false;
    autoResolveRef.current = false;
    setAutoActivate(false);
    setAutoQA(false);
    setAutoRetire(false);
    setAutoResolve(false);
    setResolveStatus(null);
  }, [root]);

  const toggleAutoActivate = useCallback((v: boolean) => {
    autoActivateRef.current = v;
    skipRef.current.clear();
    implHandledRef.current.clear();
    setAutoActivate(v);
  }, []);

  const toggleAutoQA = useCallback((v: boolean) => {
    autoQARef.current = v;
    qaHandledRef.current.clear();
    setAutoQA(v);
  }, []);

  const toggleAutoRetire = useCallback((v: boolean) => {
    retiredRef.current.clear();
    setAutoRetire(v);
  }, []);

  const toggleAutoResolve = useCallback((v: boolean) => {
    autoResolveRef.current = v;
    resolveHandledRef.current.clear();
    setResolveStatus(null);
    setAutoResolve(v);
  }, []);

  // Auto-activate: while on, activate the first ready ticket (registration
  // order — to-issues registers in dependency order) + spawn its impl agent,
  // re-reading status each pass so deps and the slot gate stay current.
  //
  // The slot gate — sequential's empty-line rule, or max_active in parallel —
  // is checked here and *pauses* the drain (break) rather than parking the
  // ticket: "no slot" is transient, and letting it fall through to a failed
  // `activate` would poison the skip-set for the whole episode. skipRef is
  // only for real per-ticket failures.
  useEffect(() => {
    if (!autoActivate || !root || !ws) return;
    if (drainingRef.current) return;
    if (!ws.tickets.some((t) => t.state === "queued" && t.ready)) return;
    drainingRef.current = true;
    (async () => {
      try {
        while (autoActivateRef.current) {
          const data = await api.iudexStatus(root);
          if (sequentialRef.current) {
            if (data.tickets.some((t) => IN_FLIGHT_STATES.has(t.state))) break;
          } else if (data.maxActive > 0) {
            const active = data.tickets.filter(
              (t) => t.state === "active",
            ).length;
            if (active >= data.maxActive) break;
          }
          const next = data.tickets.find(
            (t) =>
              t.state === "queued" && t.ready && !skipRef.current.has(t.id),
          );
          if (!next) break;
          try {
            await api.runIudex(root, ["activate", next.id]);
            implHandledRef.current.add(next.id); // the respawn drain must not double-spawn
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
  }, [autoActivate, sequential, root, ws, load, onError]);

  // Auto-respawn (part of Auto-Activate): an `active` ticket with no live impl
  // session is what a qa-reject or human-qa reject leaves behind — spawn a
  // fresh impl agent so the feedback in .task/review.md gets addressed. The
  // qa-reject ladder is capped by qa_reject_limit, and a human reject was
  // itself the human decision, so both respawns are plumbing, not judgment.
  //
  // A *crashed* impl agent (dead session, non-zero exit) also leaves the ticket
  // active — deliberately NOT respawned (notify-only policy: the Agents view
  // surfaces "crashed"; no spawn loops on a systematically failing command).
  // Episode-guarded like auto-QA: handled once per stay in `active`, cleared
  // when the ticket leaves the state; sessions are re-fetched fresh to shrink
  // the poll-lag double-spawn window.
  useEffect(() => {
    if (!autoActivate || !root || !ws) return;
    const activeIds = new Set(
      ws.tickets.filter((t) => t.state === "active").map((t) => t.id),
    );
    for (const id of implHandledRef.current) {
      if (!activeIds.has(id)) implHandledRef.current.delete(id);
    }
    const candidates = [...activeIds].filter(
      (id) => !implHandledRef.current.has(id),
    );
    if (candidates.length === 0 || implDrainingRef.current) return;
    implDrainingRef.current = true;
    (async () => {
      try {
        const fresh = await api.listSessions(root).catch(() => sessions);
        for (const id of candidates) {
          if (!autoActivateRef.current) break;
          const implSessions = fresh.filter(
            (s) => s.kind === "agent" && s.role === "impl" && s.ticket === id,
          );
          let live = false;
          let crashed = false;
          for (const s of implSessions) {
            try {
              const st = await api.sessionStatus(s.name);
              if (!st.dead) {
                live = true;
                break;
              }
              if (st.exitCode !== null && st.exitCode !== 0) crashed = true;
            } catch {
              // unknown → treat as not-live
            }
          }
          implHandledRef.current.add(id);
          if (live || crashed) continue;
          try {
            await api.spawnAgent(root, id, "impl");
          } catch (e) {
            onError(String(e));
          }
        }
      } finally {
        implDrainingRef.current = false;
      }
    })();
  }, [autoActivate, root, ws, sessions, onError]);

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

  // Auto-resolve: keep the front of the review queue mergeable. Candidate =
  // the FIRST pending-human-qa ticket (registration order) whose preflight
  // predicts conflicts — clean ones are skipped past. Strictly one resolution
  // at a time: while the candidate is being resolved or is parked (flagged /
  // crashed / the human's own merge), no other ticket is touched. Episode
  // guards clear whenever the done-count changes (a sibling merged ⇒ main
  // moved ⇒ the next *incremental* pass may fire). Full design:
  // .context/prd/auto-resolve.md.
  useEffect(() => {
    if (!root || !ws) return;
    // Track merges even while the toggle is off, so arming it mid-session
    // starts from the current episode rather than a stale one.
    const done = ws.tickets.filter((t) => t.state === "done").length;
    if (done !== doneCountRef.current) {
      doneCountRef.current = done;
      resolveHandledRef.current.clear();
    }
    if (!autoResolve || resolveDrainingRef.current) return;
    const candidates = ws.tickets.filter(
      (t) => t.state === "pending-human-qa" && t.worktree,
    );
    if (candidates.length === 0) {
      setResolveStatus(null);
      return;
    }
    resolveDrainingRef.current = true;
    (async () => {
      let status: ResolveStatus | null = null;
      try {
        for (const t of candidates) {
          if (!autoResolveRef.current) break;
          const wt = t.worktree!;

          // Resolver session state for this ticket (fresh probe, like auto-QA).
          const resolveSessions = sessions.filter(
            (s) => s.kind === "agent" && s.role === "resolve" && s.ticket === t.id,
          );
          let live = false;
          let crashed = false;
          for (const sx of resolveSessions) {
            try {
              const st = await api.sessionStatus(sx.name);
              if (!st.dead) {
                live = true;
                break;
              }
              if (st.exitCode !== null && st.exitCode !== 0) crashed = true;
            } catch {
              // unknown → treat as not-live
            }
          }

          const res = await api.readResolution(wt);
          if (res.mergeInProgress) {
            if (live) {
              status = { ticket: t.id, phase: "resolving" };
            } else if (crashed) {
              // Notify-only, like impl crashes: never respawn into a merge a
              // crashed agent may have half-touched. The line waits for you.
              status = { ticket: t.id, phase: "crashed" };
            } else if (res.hasReport && res.flagged.length > 0) {
              status = { ticket: t.id, phase: "flagged" };
            } else if (!res.hasReport && !autoBegunRef.current.has(t.id)) {
              // The human's own merge (manual Begin-resolution / hand-editing):
              // hands off entirely — and per one-at-a-time, the line waits.
              status = null;
            } else {
              // Our merge with no live agent and no flags (spawn failed, or a
              // report without a commit): needs a human look.
              status = { ticket: t.id, phase: "crashed" };
            }
            break; // one at a time — never look past an in-progress merge
          }

          const pf = await api.mergePreflight(root, wt, ws.mainBranch);
          if (!pf.wouldConflict) continue; // mergeable — not our problem; next
          if (resolveHandledRef.current.has(t.id)) {
            // Already ran this episode (e.g. the human aborted our merge —
            // their call). Wait for the next episode rather than re-spawning.
            status = null;
            break;
          }
          resolveHandledRef.current.add(t.id);
          autoBegunRef.current.add(t.id);
          try {
            await api.beginResolution(wt, ws.mainBranch);
            await api.spawnResolver(root, t.id, wt);
            status = { ticket: t.id, phase: "resolving" };
          } catch (e) {
            onError(String(e));
            status = { ticket: t.id, phase: "crashed" };
          }
          break; // strictly one
        }
      } finally {
        resolveDrainingRef.current = false;
        setResolveStatus(status);
      }
    })();
  }, [autoResolve, root, ws, sessions, onError]);

  // Auto-retire: kill agents whose ticket has moved past their role's phase — a
  // clean transition supersedes them (the work is committed, the phase advanced).
  // Derived from ws+sessions alone (no tmux liveness poll), so it fires on the
  // doorbell and, by construction, leaves crashed agents (ticket never moved) and
  // flagged/working resolvers (ticket still pending-human-qa) untouched. The
  // sessions poll lags the kill by up to its interval, so a name-keyed guard
  // avoids re-issuing kills while the dead session lingers in the list.
  useEffect(() => {
    if (!autoRetire || !root || !ws) return;
    const live = new Set(sessions.map((s) => s.name));
    for (const name of retiredRef.current) {
      if (!live.has(name)) retiredRef.current.delete(name); // reaped — forget it
    }
    const superseded = sessions.filter((sx) => {
      if (sx.kind !== "agent" || !sx.ticket || !sx.role) return false;
      const phase = AGENT_PHASE[sx.role];
      if (!phase) return false; // unknown role → leave it alone
      const t = ws.tickets.find((t) => t.id === sx.ticket);
      return !!t && t.state !== phase && !retiredRef.current.has(sx.name);
    });
    for (const sx of superseded) {
      retiredRef.current.add(sx.name);
      api.killSession(sx.name).catch(() => {});
    }
  }, [autoRetire, root, ws, sessions]);

  // While any automation is on, poll the workspace every 5s so the drains
  // re-evaluate on a steady cadence (not only on the events doorbell) — freeing
  // slots / newly-queued / newly-pending-qa tickets get picked up.
  useEffect(() => {
    if (!root || (!autoActivate && !autoQA && !autoRetire && !autoResolve))
      return;
    const h = setInterval(() => load(root), 5000);
    return () => clearInterval(h);
  }, [autoActivate, autoQA, autoRetire, autoResolve, root, load]);

  return {
    autoActivate,
    autoQA,
    autoRetire,
    autoResolve,
    resolveStatus,
    sequential,
    toggleAutoActivate,
    toggleAutoQA,
    toggleAutoRetire,
    toggleAutoResolve,
    toggleSequential,
  };
}

// What Auto-Resolve is currently doing / waiting on — rendered on its
// transport row so a parked line ("your turn") is visible from every view.
export type ResolveStatus = {
  ticket: string;
  phase: "resolving" | "flagged" | "crashed";
};

// The ticket state in which each agent role is the one doing the work; once the
// ticket leaves it, that role's agent is superseded. idea agents have no phase
// (not ticket-scoped) and are never auto-retired.
const AGENT_PHASE: Record<string, string> = {
  impl: "active",
  qa: "pending-qa",
  resolve: "pending-human-qa",
};
