import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import type { Resolution, Session, Workspace } from "../types";

export type AgentStatus =
  | "working"
  | "idle"
  | "awaiting-finish"
  | "review-ready"
  | "resolved"
  | "flagged"
  | "crashed"
  | "done"
  | "gone";

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "working",
  // A live pane gone quiet: this is BOTH "finished its turn, waiting on you" and
  // "stalled / gave up" — the GUI deliberately doesn't detect which (that'd mean
  // per-harness output scraping). The label says "check it" rather than implying
  // all-is-well; the human's glance at the console is the cross-harness detector.
  idle: "quiet — check it",
  "awaiting-finish": "awaiting finish",
  "review-ready": "review ready",
  resolved: "resolved",
  flagged: "flagged",
  crashed: "crashed",
  done: "done",
  gone: "gone",
};

// "Finished" for clear-all-finished: the agent won't do more work — its ticket
// has moved past its role (done), the merge it ran is committed (resolved), or
// its process died (crashed). NOT `flagged`: that's a needs-you marker, kept in
// the rail until you handle it (it self-clears to `resolved` once committed).
export function isFinished(s: AgentStatus): boolean {
  return s === "done" || s === "resolved" || s === "crashed";
}

// The remedy ladder for a stalled agent (Agents view). Two independent gates:
//
// canResume — the pane is still ALIVE (working|idle are the only live-pane
//   statuses; everything else is a dead/terminal pane). Resume nudges the live
//   REPL, so it only makes sense while there's a process to talk to.
// canRestart — there's a ticket to respawn from (a real ticket agent, not an
//   idea session, whose seed we don't retain). Works on live OR dead panes —
//   Restart is exactly the remedy for a `crashed` (dead) agent.
export function canResume(s: AgentStatus): boolean {
  return s === "working" || s === "idle";
}
export function canRestart(agent: Session): boolean {
  return agent.kind === "agent" && !!agent.ticket;
}

export type AgentBucket = "working" | "needs-you" | "finished";

// Coarse grouping for the Agents rail-header summary — an exhaustive partition
// of every AgentStatus into three buckets:
//   working   — actively running or alive-but-quiet (working, idle)
//   needs-you — parked at a human gate (awaiting-finish, review-ready, flagged)
//   finished  — terminal: completed, merged, or dead (done, resolved, crashed, gone)
// Exhaustive (no `default`) so a new AgentStatus forces a decision here.
export function agentBucket(s: AgentStatus): AgentBucket {
  switch (s) {
    case "working":
    case "idle":
      return "working";
    case "awaiting-finish":
    case "review-ready":
    case "flagged":
      return "needs-you";
    case "resolved":
    case "done":
    case "crashed":
    case "gone":
      return "finished";
  }
}

// A resolver agent's status derived from the authoritative git merge state +
// the resolution.json it writes (read via read_resolution), rather than from
// process liveness alone. Live-derived, so it self-heals: once you commit (or
// abort) the merge in Review, `flagged` re-derives to `resolved` on its own.
export function resolveStatus(opts: {
  dead: boolean;
  exitCode: number | null;
  ticketState: string | undefined;
  quietMs: number;
  resolution: Resolution | null;
}): AgentStatus {
  const { dead, exitCode, ticketState, quietMs, resolution } = opts;
  // Human approved/rejected → ticket left pending-human-qa → this agent is done.
  if (ticketState !== "pending-human-qa") return "done";
  if (dead && exitCode !== 0) return "crashed";
  if (resolution) {
    // No merge in progress → it was committed (or aborted): episode over.
    if (!resolution.mergeInProgress) return "resolved";
    // Conflicts left for a human: either the agent explicitly flagged a file
    // (gave it a reason in its report), or it exited with files still unmerged.
    // `flagged` lists EVERY unmerged file, so checking the count would read as
    // flagged the instant the merge starts — gate on a reason / on the process
    // having exited instead, so a working agent stays "working".
    if (resolution.flagged.some((f) => f.reason) || dead) return "flagged";
  }
  // Merge in progress, nothing flagged yet — still working.
  return quietMs < 5000 ? "working" : "idle";
}

// An idea-shaping agent's status. Idea agents aren't ticket-scoped (no role
// phase to compare against), so their status is pure process liveness: a clean
// exit is done, a non-zero exit crashed, otherwise working/idle by output quiet.
export function ideaStatus(opts: {
  dead: boolean;
  exitCode: number | null;
  quietMs: number;
}): AgentStatus {
  if (opts.dead) return opts.exitCode !== 0 ? "crashed" : "done";
  return opts.quietMs < 5000 ? "working" : "idle";
}

// Synthesize an agent's status from process liveness (pane dead/exit), output
// activity, and the ticket's state relative to the agent's role. iudex has no
// liveness signal of its own; these are the signals a bare `iudex status` can't
// show, named after the *right* next action.
export function synthStatus(opts: {
  dead: boolean;
  exitCode: number | null;
  role: string | null | undefined;
  ticketState: string | undefined;
  quietMs: number;
}): AgentStatus {
  const { dead, exitCode, role, ticketState, quietMs } = opts;
  // The state in which this role's agent is the one doing the work.
  const expected =
    role === "qa"
      ? "pending-qa"
      : role === "resolve"
        ? "pending-human-qa"
        : "active";
  // Ticket has moved past the role's phase — this agent is superseded.
  if (ticketState !== expected) return "done";
  if (dead) {
    if (exitCode !== 0) return "crashed";
    return role === "qa" ? "review-ready" : "awaiting-finish";
  }
  return quietMs < 5000 ? "working" : "idle";
}

// Poll every agent's liveness + output activity and project it to a status map
// keyed by session name. Lifted to a hook (rather than per-card) so the parent
// can both render the cards and compute the clear-all-finished set.
export function useAgentStatuses(
  agents: Session[],
  ws: Workspace,
): Record<string, AgentStatus> {
  const [map, setMap] = useState<Record<string, AgentStatus>>({});
  const activity = useRef<Record<string, { prev: string; last: number }>>({});
  const names = agents.map((a) => a.name).join(",");

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      // Nothing is watching while the window is hidden — don't spawn tmux
      // probes for it (same policy as the shared sessions poll).
      if (document.visibilityState === "hidden") return;
      // One tmux call for every session's liveness, instead of one per agent.
      let stats: Map<string, api.NamedSessionStatus>;
      try {
        stats = new Map(
          (await api.sessionStatuses()).map((s) => [s.name, s]),
        );
      } catch {
        return; // transient tmux failure — keep the previous map
      }
      const entries = await Promise.all(
        agents.map(async (a) => {
          try {
            const live = stats.get(a.name);
            if (!live) return [a.name, "gone" as AgentStatus] as const;
            // Output-activity capture only matters for a *live* pane (every
            // dead-pane status is decided by exit code / ticket state alone).
            let quietMs = 0;
            if (!live.dead) {
              const out = await api.capturePane(a.name, 200);
              const act = activity.current[a.name] ?? {
                prev: "",
                last: Date.now(),
              };
              if (out !== act.prev) {
                act.prev = out;
                act.last = Date.now();
              }
              activity.current[a.name] = act;
              quietMs = Date.now() - act.last;
            }
            const ticket = a.ticket
              ? ws.tickets.find((t) => t.id === a.ticket)
              : undefined;

            // Idea agents are ticket-less; status is pure liveness.
            if (a.kind === "idea") {
              return [
                a.name,
                ideaStatus({
                  dead: live.dead,
                  exitCode: live.exitCode,
                  quietMs,
                }),
              ] as const;
            }

            // Resolver agents derive their outcome from the merge state, not just
            // process liveness, so the panel shows resolved / flagged / working.
            if (a.role === "resolve") {
              let resolution: Resolution | null = null;
              if (ticket?.worktree) {
                resolution = await api
                  .readResolution(ticket.worktree)
                  .catch(() => null);
              }
              return [
                a.name,
                resolveStatus({
                  dead: live.dead,
                  exitCode: live.exitCode,
                  ticketState: ticket?.state,
                  quietMs,
                  resolution,
                }),
              ] as const;
            }

            return [
              a.name,
              synthStatus({
                dead: live.dead,
                exitCode: live.exitCode,
                role: a.role,
                ticketState: ticket?.state,
                quietMs,
              }),
            ] as const;
          } catch {
            return [a.name, "gone" as AgentStatus] as const;
          }
        }),
      );
      if (alive) setMap(Object.fromEntries(entries));
    };
    tick();
    const h = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(h);
    };
    // `names` stands in for the agent array; `ws` carries the latest ticket states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names, ws]);

  return map;
}

// Ticket titles keyed by ticket id (e.g. `t3`), covering queued tickets too:
// the backend reads the worktree brief for active+ tickets and the queue file
// for queued ones (which have no worktree). Re-runs on the `ws` doorbell, and
// exposes `refetch` for writes that change a title without an event (e.g. an
// edited queue brief, which the doorbell never sees).
export function useTicketTitles(
  root: string,
  ws: Workspace,
): { titles: Record<string, string>; refetch: () => void } {
  const [titles, setTitles] = useState<Record<string, string>>({});

  const refetch = useCallback(() => {
    if (!root) {
      setTitles({});
      return;
    }
    api
      .ticketTitles(root)
      .then((rows) => {
        const m: Record<string, string> = {};
        for (const r of rows) m[r.id] = r.title;
        setTitles(m);
      })
      .catch(() => setTitles({}));
  }, [root]);

  // Doorbell path: re-read whenever the workspace snapshot changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refetch, [root, ws]);

  return { titles, refetch };
}

// Ticket titles for a set of worktree paths, keyed by path — the Agents card
// labels. Re-runs when the worktree set or `ws` (doorbell) changes.
export function useBriefTitles(
  worktrees: string[],
  ws: Workspace,
): Record<string, string> {
  const [titles, setTitles] = useState<Record<string, string>>({});
  const key = worktrees.join("|");

  useEffect(() => {
    if (worktrees.length === 0) {
      setTitles({});
      return;
    }
    let alive = true;
    api
      .briefTitles(worktrees)
      .then((rows) => {
        if (!alive) return;
        const m: Record<string, string> = {};
        for (const r of rows) m[r.worktree] = r.title;
        setTitles(m);
      })
      .catch(() => alive && setTitles({}));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ws]);

  return titles;
}
