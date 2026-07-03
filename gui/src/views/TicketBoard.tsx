import { useEffect, useRef } from "react";
import type { Ticket, Session } from "../types";
import { stateDot } from "../lib/badges";
import s from "./TicketBoard.module.scss";

// The pipeline as a board: one column per stage, tickets as state-colored clips.
// A reactive, read-derived board —
// clicking a card selects it (opening the shared detail panel), where the
// state-aware actions live. Done/removed tickets aren't part of the live
// pipeline, so they don't appear.
const COLUMNS: { state: string; label: string }[] = [
  { state: "queued", label: "Queued" },
  { state: "active", label: "Active" },
  { state: "pending-qa", label: "In QA" },
  { state: "pending-human-qa", label: "Human Review" },
  { state: "failed", label: "Failed" },
];

// Per-state clip colors (mirrors the design; the registry's `bg` is tuned for
// the small table pills, so the board keeps its own slightly lighter fills).
const CLIP: Record<string, { bg: string; border: string; fg: string }> = {
  queued: { bg: "#9c9c9c", border: "#6f6f6f", fg: "#2a2a2a" },
  active: { bg: "#f4bc41", border: "#c79320", fg: "#2a2a2a" },
  "pending-qa": { bg: "#5bc7d8", border: "#3a96a5", fg: "#10333a" },
  "pending-human-qa": { bg: "#836ddd", border: "#5b46b0", fg: "#ffffff" },
  failed: { bg: "#e0584c", border: "#b03d33", fg: "#ffffff" },
};

// Selection palette (mirrors tokens.scss $sel-bg/$sel-border/$sel-text).
const SEL = { bg: "#1f2e90", border: "#14206b", fg: "#ffffff" };

const rejects = (n: number) => `${n} reject${n === 1 ? "" : "s"}`;

// Top-right tag on a clip — derived only from real status fields.
function clipMeta(t: Ticket): string {
  switch (t.state) {
    case "queued":
      return t.ready ? "▸" : "";
    case "pending-human-qa":
      return "▸";
    case "failed":
      return t.qaRejects > 0 ? rejects(t.qaRejects) : "";
    default:
      return "";
  }
}

export default function TicketBoard({
  tickets,
  titles,
  sessions,
  maxActive,
  selId,
  onSelect,
}: {
  tickets: Ticket[];
  titles: Record<string, string>;
  sessions: Session[];
  maxActive: number;
  selId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const byState = (st: string) => tickets.filter((t) => t.state === st);
  const titleOf = (t: Ticket) => titles[t.id] || "";

  // Running-agent indicator (presence-based, matching the rest of the app):
  // the distinct roles of agent sessions in the pool tagged to this ticket, so
  // the board shows "an agent is on it" without opening the detail panel.
  const agentRoles = (t: Ticket): string[] => {
    const roles = sessions
      .filter((x) => x.kind === "agent" && x.ticket === t.id)
      .map((x) => x.role || "agent");
    return [...new Set(roles)];
  };

  // Scroll the selected card into view: opening the detail panel can clip the
  // clicked card off-screen, so pull it back into the visible area.
  const selRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selId && selRef.current) {
      selRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [selId]);

  const activeCount = byState("active").length;
  const freeSlots = maxActive > 0 ? Math.max(0, maxActive - activeCount) : 0;

  const live = tickets.filter((t) => COLUMNS.some((c) => c.state === t.state));
  if (live.length === 0)
    return <div className={s.empty}>No tickets in the pipeline</div>;

  return (
    <div className={s.board}>
      <div className={s.headRow}>
        {COLUMNS.map((c) => (
          <div key={c.state} className={s.colHead}>
            <span>{c.label}</span>
            <span className={s.colCount} style={{ color: stateDot(c.state) }}>
              {byState(c.state).length}
            </span>
          </div>
        ))}
      </div>

      <div className={s.colsRow}>
        {COLUMNS.map((c) => {
          const col = CLIP[c.state];
          return (
            <div key={c.state} className={s.col}>
              {byState(c.state).map((t) => {
                const meta = clipMeta(t);
                const roles = agentRoles(t);
                const sel = t.id === selId;
                // Selected card: paint the whole clip with the selection color
                // (matches the nav-row selection language) rather than a border.
                const fill = sel
                  ? {
                      background: SEL.bg,
                      borderColor: SEL.border,
                      color: SEL.fg,
                    }
                  : {
                      background: col.bg,
                      borderColor: col.border,
                      color: col.fg,
                    };
                return (
                  <div
                    key={t.id}
                    ref={sel ? selRef : undefined}
                    className={s.card}
                    style={fill}
                    onClick={() => onSelect(sel ? null : t.id)}
                  >
                    <div className={s.cardTop}>
                      <span className={s.cardId}>{t.id}</span>
                      {meta && <span className={s.cardMeta}>{meta}</span>}
                    </div>
                    {titleOf(t) && (
                      <div className={s.cardTitle}>{titleOf(t)}</div>
                    )}
                    {roles.length > 0 && (
                      <div
                        className={s.cardAgent}
                        title={`Agent running: ${roles.join(", ")}`}
                      >
                        <span className={s.agentDot} />
                        <span className={s.agentRole}>{roles.join(" · ")}</span>
                      </div>
                    )}
                  </div>
                );
              })}
              {c.state === "active" && freeSlots > 0 && (
                <div className={s.slot}>slot · {freeSlots} free</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
