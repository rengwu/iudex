import s from "./StateBadge.module.scss";

// The ticket-lifecycle state pill, shared by every view that shows a ticket
// (Tickets, Dashboard, Review, Agents). pending-qa and pending-human-qa share
// one look.
const CLASS: Record<string, string> = {
  queued: s.queued,
  active: s.active,
  "pending-qa": s.pending,
  "pending-human-qa": s.pending,
  done: s.done,
  failed: s.failed,
  removed: s.removed,
};

// The scoped state-color class, for badges that aren't the standard pill (e.g.
// the Worktrees rail's "tN · state" chip) but want the same color vocabulary.
export function stateColor(state: string): string {
  return CLASS[state] ?? "";
}

export default function StateBadge({ state }: { state: string }) {
  return <span className={`${s.badge} ${stateColor(state)}`}>{state}</span>;
}
