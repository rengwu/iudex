import type { View, Workspace } from "../types";
import StateBadge from "../components/StateBadge";
import s from "./Dashboard.module.scss";

// The light, glanceable router: "what needs me right now?". It derives every
// pile from the latest status --json (no authoritative state of its own) and
// makes each item one click to its destination view. The agent-attention pile
// (crashed / idle / awaiting-finish) needs the tmux process layer and lands
// with step 4; until then this surfaces the piles we can read today.
export default function Dashboard({
  ws,
  onJump,
  onOpenReview,
}: {
  ws: Workspace;
  onJump: (v: View) => void;
  onOpenReview: (id: string) => void;
}) {
  const activeCount = ws.tickets.filter((t) => t.state === "active").length;
  const atCapacity = ws.maxActive > 0 && activeCount >= ws.maxActive;

  const ready = ws.tickets.filter((t) => t.state === "queued" && t.ready);
  const pendingReview = ws.tickets.filter((t) => t.state === "pending-human-qa");
  const pendingQa = ws.tickets.filter((t) => t.state === "pending-qa");
  const failed = ws.tickets.filter((t) => t.state === "failed");

  return (
    <div className={s.dash}>
      <Pile
        title="Ready to activate"
        hint={
          atCapacity
            ? `at capacity (${activeCount}/${ws.maxActive} active)`
            : "deps cleared"
        }
        tickets={ready}
        onClick={() => onJump("tickets")}
        muted={atCapacity}
        emptyText="nothing ready"
      />
      <Pile
        title="Pending human review"
        hint="awaiting your judgment"
        tickets={pendingReview}
        onClick={() => onJump("review")}
        onItem={onOpenReview}
        accent="review"
        emptyText="nothing to review"
      />
      <Pile
        title="In QA"
        hint="awaiting agent QA"
        tickets={pendingQa}
        onClick={() => onJump("tickets")}
        emptyText="none in QA"
      />
      <Pile
        title="Failed — needs a retry decision"
        hint="hit the qa-reject limit"
        tickets={failed}
        onClick={() => onJump("tickets")}
        accent="failed"
        emptyText="none failed"
      />
    </div>
  );
}

function Pile({
  title,
  hint,
  tickets,
  onClick,
  onItem,
  emptyText,
  accent,
  muted,
}: {
  title: string;
  hint: string;
  tickets: { id: string; state: string }[];
  onClick: () => void;
  onItem?: (id: string) => void;
  emptyText: string;
  accent?: "review" | "failed";
  muted?: boolean;
}) {
  return (
    <section className={`${s.pile} ${accent ? s[accent] : ""}`}>
      <header>
        <span className={s.title}>{title}</span>
        <span className={s.count}>{tickets.length}</span>
      </header>
      <div className={s.hint}>{hint}</div>
      {tickets.length === 0 ? (
        <div className={s.empty}>{emptyText}</div>
      ) : (
        <ul className={s.items}>
          {tickets.map((t) => (
            <li
              key={t.id}
              className={muted ? s.dimmed : ""}
              onClick={(e) => {
                if (onItem) {
                  e.stopPropagation();
                  onItem(t.id);
                } else {
                  onClick();
                }
              }}
              title="open"
            >
              <span className={s.id}>{t.id}</span>
              <StateBadge state={t.state} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
