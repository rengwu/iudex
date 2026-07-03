import type { Session, Ticket, Workspace, View } from "../types";
import type { Focus } from "./nav";
import type { ResolveStatus } from "./automation";
import { liveAgentFor, inFlightBlocker } from "./ticketActions";

// The Dashboard's NOW strip: a workspace-level sibling of `nextAction` — one
// pure, single-sourced ranking of everything that needs a human, most urgent
// first. Problems outrank the review gate (decided in
// .context/prd/dashboard.md): broken things rot silently, while review items
// already announce themselves via the nav count. Actions *navigate* to the
// focused view (which owns the buttons and their busy/error plumbing) rather
// than execute.

export type HomeTone = "danger" | "review" | "work" | "idle";

export type HomeAction = {
  key: string; // stable list key
  tone: HomeTone;
  label: string;
  view: View | null; // null → focus the START seed box instead of navigating
  focus?: Focus;
};

// An agent whose process died while its ticket still sits in its phase —
// gathered by the Dashboard via sessionStatus probes (async, so an input
// here rather than derived inside).
export type CrashedAgent = { ticket: string; session: string; role: string };

export function workspaceActions(opts: {
  ws: Workspace;
  sessions: Session[];
  crashed: CrashedAgent[];
  resolveStatus: ResolveStatus | null;
  sequential: boolean;
  titles: Record<string, string>;
}): HomeAction[] {
  const { ws, sessions, crashed, resolveStatus, sequential, titles } = opts;
  const t = (id: string) => {
    const title = titles[id];
    return title ? `${id} — ${title}` : id;
  };
  const byState = (state: string) =>
    ws.tickets.filter((x) => x.state === state);
  const out: HomeAction[] = [];

  // 1. A parked resolution line: the merge waits on the human.
  if (resolveStatus && resolveStatus.phase !== "resolving") {
    out.push({
      key: `resolve-${resolveStatus.ticket}`,
      tone: "danger",
      label: `Resolution ${resolveStatus.phase} on ${resolveStatus.ticket} — your turn`,
      view: "review",
      focus: { id: resolveStatus.ticket },
    });
  }

  // 2. Crashed agents (ticket never moved; nothing will happen on its own).
  for (const c of crashed) {
    out.push({
      key: `crash-${c.session}`,
      tone: "danger",
      label: `${c.role} agent crashed on ${c.ticket}`,
      view: "agents",
      focus: { id: c.session },
    });
  }

  // 3. The human gate.
  for (const x of byState("pending-human-qa")) {
    out.push({
      key: `review-${x.id}`,
      tone: "review",
      label: `Review ${t(x.id)}`,
      view: "review",
      focus: { id: x.id },
    });
  }

  // 4. Failed tickets: parked on a retry/remove decision.
  for (const x of byState("failed")) {
    out.push({
      key: `failed-${x.id}`,
      tone: "danger",
      label: `${x.id} failed QA — retry or remove`,
      view: "tickets",
      focus: { id: x.id },
    });
  }

  // 5. Rejected-back (or never-staffed) actives: no one is working on them.
  for (const x of byState("active")) {
    if (!liveAgentFor(x, sessions)) {
      out.push({
        key: `resume-${x.id}`,
        tone: "work",
        label: `Resume impl on ${t(x.id)}`,
        view: "tickets",
        focus: { id: x.id },
      });
    }
  }

  // 6. Unstaffed QA.
  for (const x of byState("pending-qa")) {
    if (!liveAgentFor(x, sessions)) {
      out.push({
        key: `qa-${x.id}`,
        tone: "work",
        label: `Start QA on ${t(x.id)}`,
        view: "tickets",
        focus: { id: x.id },
      });
    }
  }

  // 7. Ready-to-activate — gated by the sequential policy, same as the views.
  const blocker = sequential ? inFlightBlocker(ws.tickets) : null;
  if (!blocker) {
    for (const x of ws.tickets) {
      if (x.state === "queued" && x.ready) {
        out.push({
          key: `activate-${x.id}`,
          tone: "work",
          label: `Activate ${t(x.id)}`,
          view: "tickets",
          focus: { id: x.id },
        });
      }
    }
  }

  // 8. Nothing needs anyone: the line is clear.
  if (out.length === 0) {
    out.push({
      key: "idle",
      tone: "idle",
      label: "Line clear — shape an idea",
      view: null,
    });
  }
  return out;
}

// Compact relative time for the activity feed ("now", "12m", "3h", "2d").
export function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Which ticket state each agent role serves — a crashed agent only matters
// while its ticket is still in that phase (same rule as auto-retire).
export const ROLE_PHASE: Record<string, string> = {
  impl: "active",
  qa: "pending-qa",
};

// Tickets whose phase-matching agent sessions should be liveness-probed for
// the crashed check (kind/role/phase filter is sync; the probe itself isn't).
export function crashCandidates(ws: Workspace, sessions: Session[]): Session[] {
  const stateOf = new Map(ws.tickets.map((x: Ticket) => [x.id, x.state]));
  return sessions.filter(
    (s) =>
      s.kind === "agent" &&
      !!s.ticket &&
      !!s.role &&
      ROLE_PHASE[s.role] !== undefined &&
      stateOf.get(s.ticket) === ROLE_PHASE[s.role],
  );
}
