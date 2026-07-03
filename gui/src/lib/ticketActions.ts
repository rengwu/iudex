import type { Variant } from "../components/Button";
import type { Session, Ticket } from "../types";

// "In flight" for the sequential policy: a ticket someone (or some agent) is
// actively responsible for. `failed` is deliberately excluded — it is a parked
// human decision (retry/remove), and blocking the line on it would deadlock
// the pipeline on its least-productive member (.context/prd/sequential-mode.md).
export const IN_FLIGHT_STATES = new Set([
  "active",
  "pending-qa",
  "pending-human-qa",
]);

// The ticket currently occupying the sequential line, if any — the id shown in
// the "sequential — tN in flight" hint and the gate for new activations.
export function inFlightBlocker(tickets: Ticket[]): string | null {
  const t = tickets.find((t) => IN_FLIGHT_STATES.has(t.state));
  return t ? t.id : null;
}

// The single source of "what's the next thing to do with this ticket" — consumed
// by both the Tickets table row (`rowAction`) and the detail panel footer
// (`FooterActions`), so the two can never disagree on which primary action a
// ticket offers. It is a *pure* descriptor: it decides the intent + label, never
// the side effect. Each view owns a thin `runIntent` that maps the intent to its
// own handler (busy-tracking and post-action nav legitimately differ per view).

export type Intent =
  | "activate-impl" // queued + ready: activate, then spawn impl, jump to Agents
  | "resume-impl" // active + no agent: spawn impl agent (post-reject resume)
  | "open-agent" // active/pending-qa + a live agent already exists: jump to it
  | "spawn-qa" // pending-qa + no agent: spawn QA agent
  | "review" // pending-human-qa: jump to Review
  | "retry" // failed: retry
  | "note"; // non-action: muted text, no button (blocked / merged / terminal)

export interface TicketAction {
  intent: Intent;
  label: string;
  variant?: Variant; // present iff actionable; a bare `note` has none
}

// The agent role that does the work in a given state — impl while active, qa
// while pending-qa. Returns null for states with no role-scoped agent. Used to
// both pick which session to look for and which role a spawn should create.
export function expectedRole(state: string): "impl" | "qa" | null {
  if (state === "active") return "impl";
  if (state === "pending-qa") return "qa";
  return null;
}

// The session for this ticket's expected role, if one is present in the pool.
// Presence-based (a session existing, regardless of liveness — see #1 in
// gui-ux-fixes.md): the list carries no liveness signal, and a lingering dead
// session is handled by opening it, then killing it to respawn. When more than
// one matches, return the most recently started (highest `started`), so
// "Open agent" jumps to the freshest. Single-sources the match rule for both
// `nextAction` (which action) and the views' `runIntent` (which session to open).
export function liveAgentFor(
  t: Ticket,
  sessions: Session[],
): Session | undefined {
  const role = expectedRole(t.state);
  if (!role) return undefined;
  return sessions
    .filter((s) => s.kind === "agent" && s.ticket === t.id && s.role === role)
    .sort((a, b) => (b.started ?? "").localeCompare(a.started ?? ""))[0];
}

// `seqBlocker`: the in-flight ticket id when sequential mode gates activation
// (null/undefined otherwise). Sequential is a hard policy — the GUI refuses to
// activate past it even manually — but the CLI can always bypass, so the note
// names the blocker instead of pretending the action doesn't exist.
export function nextAction(
  t: Ticket,
  sessions: Session[],
  seqBlocker?: string | null,
): TicketAction {
  switch (t.state) {
    case "queued":
      if (!t.ready) return { intent: "note", label: "blocked" };
      return seqBlocker
        ? { intent: "note", label: `sequential — ${seqBlocker} in flight` }
        : { intent: "activate-impl", label: "Activate & start", variant: "secondary" };
    case "active":
      // A live impl agent already on it → jump to it rather than spawning a
      // second (#1); otherwise offer to (re)start impl — the resume path a
      // QA/human reject opens (#5).
      return liveAgentFor(t, sessions)
        ? { intent: "open-agent", label: "Open agent", variant: "secondary" }
        : { intent: "resume-impl", label: "Resume impl", variant: "secondary" };
    case "pending-qa":
      // Same guard on the QA side: don't double-spawn a reviewer.
      return liveAgentFor(t, sessions)
        ? { intent: "open-agent", label: "Open agent", variant: "secondary" }
        : { intent: "spawn-qa", label: "Start QA", variant: "secondary" };
    case "pending-human-qa":
      return { intent: "review", label: "Review", variant: "review" };
    case "failed":
      return { intent: "retry", label: "Retry", variant: "danger" };
    case "done":
      return { intent: "note", label: "✓ merged" };
    default:
      return { intent: "note", label: "" };
  }
}
