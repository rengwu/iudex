import type { Variant } from "../components/Button";
import type { Session, Ticket } from "../types";

// The single source of "what's the next thing to do with this ticket" — consumed
// by both the Tickets table row (`rowAction`) and the detail panel footer
// (`FooterActions`), so the two can never disagree on which primary action a
// ticket offers. It is a *pure* descriptor: it decides the intent + label, never
// the side effect. Each view owns a thin `runIntent` that maps the intent to its
// own handler (busy-tracking and post-action nav legitimately differ per view).
//
// `sessions` is accepted now but not yet branched on. The follow-up (#1/#5 in
// .context/prd/gui-ux-fixes.md) fills in the active-ticket branch here only —
// `open-agent` when a live impl agent already exists, and the "Resume impl"
// relabel of `resume-impl` — without touching either view.

export type Intent =
  | "activate-impl" // queued + ready: activate, then spawn impl, jump to Agents
  | "resume-impl" // active: spawn impl agent (interim label "Spawn agent")
  | "open-agent" // reserved for #1 — jump to the live agent; unused this PR
  | "spawn-qa" // pending-qa: spawn QA agent
  | "review" // pending-human-qa: jump to Review
  | "retry" // failed: retry
  | "note"; // non-action: muted text, no button (blocked / merged / terminal)

export interface TicketAction {
  intent: Intent;
  label: string;
  variant?: Variant; // present iff actionable; a bare `note` has none
}

// `sessions` is intentionally unused until #1/#5; keep it in the signature so the
// call sites are already wired when that branch lands.
export function nextAction(t: Ticket, _sessions: Session[]): TicketAction {
  switch (t.state) {
    case "queued":
      return t.ready
        ? { intent: "activate-impl", label: "Activate & start", variant: "secondary" }
        : { intent: "note", label: "blocked" };
    case "active":
      // Interim: always offer to spawn impl. #1/#5 will branch on `sessions`
      // here (open-agent if one is live; "Resume impl" when none).
      return { intent: "resume-impl", label: "Spawn agent", variant: "secondary" };
    case "pending-qa":
      return { intent: "spawn-qa", label: "Start QA", variant: "secondary" };
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
