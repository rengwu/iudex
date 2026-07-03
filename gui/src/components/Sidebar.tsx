import {
  RAIL_VIEWS,
  RAIL_SECONDARY,
  type View,
  type Workspace,
  type Session,
} from "../types";
import type { ResolveStatus } from "../lib/automation";
import SectionHeader from "./SectionHeader";
import Toggle from "./Toggle";
import s from "./Sidebar.module.scss";

export type Automation = {
  autoActivate: boolean;
  autoQA: boolean;
  autoRetire: boolean;
  autoResolve: boolean;
  resolveStatus: ResolveStatus | null;
  sequential: boolean;
  toggleAutoActivate: (v: boolean) => void;
  toggleAutoQA: (v: boolean) => void;
  toggleAutoRetire: (v: boolean) => void;
  toggleAutoResolve: (v: boolean) => void;
  toggleSequential: (v: boolean) => void;
};

// The left navigation rail: the view buttons (BUILD / OTHERS) over a bottom panel
// of pipeline counts, the automation transport, and workspace sysinfo. Everything
// is read-derived from ws + sessions; the rail owns its own count/pipeline math.
export default function Sidebar({
  ws,
  sessions,
  view,
  setView,
  automation,
}: {
  ws: Workspace;
  sessions: Session[];
  view: View;
  setView: (v: View) => void;
  automation: Automation;
}) {
  const tickets = ws.tickets;
  const cnt = (st: string) => tickets.filter((t) => t.state === st).length;
  const activeCount = cnt("active");
  const navCounts: Partial<Record<View, number>> = {
    terminal: sessions.filter((x) => x.kind === "shell").length,
    tickets: tickets.filter((t) => t.state !== "removed" && t.state !== "done")
      .length,
    agents: sessions.filter((x) => x.kind === "agent" || x.kind === "idea")
      .length,
    worktrees: new Set(
      tickets.filter((t) => t.hasWorktree && t.worktree).map((t) => t.worktree),
    ).size,
    review: cnt("pending-human-qa"),
  };
  const pipeline = [
    { n: cnt("queued"), label: "Queued", color: "#cfcfcf" },
    { n: activeCount, label: "Active", color: "#f4bc41" },
    { n: cnt("pending-qa"), label: "QA", color: "#5bc7d8" },
    { n: cnt("pending-human-qa"), label: "Review", color: "#836ddd" },
    { n: cnt("done"), label: "Merged", color: "#5ccf5c" },
  ];

  const navButton = (v: (typeof RAIL_VIEWS)[number]) => {
    const on = view === v.id;
    const count = navCounts[v.id];
    return (
      <button
        key={v.id}
        className={s.navItem}
        onClick={() => setView(v.id)}
        style={
          on
            ? {
                borderLeftColor: "#f4bc41",
                background: "#1f2e90",
                color: "#e8e9eb",
              }
            : undefined
        }
      >
        <span className={s.navDot} style={{ background: v.dot }} />
        <span className={s.navLabel}>{v.label}</span>
        {count !== undefined && count > 0 && (
          <span
            className={s.navCount}
            style={on ? { color: "#cdd2ff" } : undefined}
          >
            {count}
          </span>
        )}
      </button>
    );
  };

  return (
    <nav className={s.rail}>
      <SectionHeader tone="dark" noBorder>
        BUILD
      </SectionHeader>
      {RAIL_VIEWS.map(navButton)}

      <SectionHeader tone="dark" noBorder>
        OTHERS
      </SectionHeader>
      {RAIL_SECONDARY.map(navButton)}

      <div className={s.railSpacer} />

      <div className={s.railBottom}>
        <TransportControls automation={automation} maxActive={ws.maxActive} />
        <PipelineSummary pipeline={pipeline} />
        <SysInfo
          mainBranch={ws.mainBranch}
          activeCount={activeCount}
          maxActive={ws.maxActive}
        />
      </div>
    </nav>
  );
}

function PipelineSummary({
  pipeline,
}: {
  pipeline: { n: number; label: string; color: string }[];
}) {
  return (
    <div className={s.pipeline}>
      <div className={s.pipeTitle}>PIPELINE</div>
      <div className={s.pipeRows}>
        {pipeline.map((p) => (
          <div key={p.label} className={s.pipeRow}>
            <span className={s.pipeNum} style={{ color: p.color }}>
              {p.n}
            </span>
            <span className={s.pipeLabel}>{p.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TransportControls({
  automation,
  maxActive,
}: {
  automation: Automation;
  maxActive: number;
}) {
  const {
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
  } = automation;
  return (
    <div className={s.transport}>
      <div className={s.toggles}>
        <div className={s.togglesTitle}>AUTOMATION</div>
        <div className={s.toggleRow}>
          <span className={s.toggleLabel}>Auto-Activate</span>
          <Toggle checked={autoActivate} onChange={toggleAutoActivate} />
        </div>
        <div className={s.toggleRow}>
          <span className={s.toggleLabel}>Auto-QA</span>
          <Toggle checked={autoQA} onChange={toggleAutoQA} />
        </div>
        <div className={s.toggleRow}>
          <span className={s.toggleLabel}>Auto-Retire</span>
          <Toggle checked={autoRetire} onChange={toggleAutoRetire} />
        </div>
        {/* The one toggle that spends tokens with no human click between
            qa-approve and review. The row doubles as status: a parked line
            (flagged/crashed = your turn) is visible from every view. */}
        <div
          className={s.toggleRow}
          title="Spawns a conflict-resolution agent when a review-ready ticket can't merge cleanly; up to one more run each time main moves. One at a time; flagged files park it for you."
        >
          <span className={s.toggleLabel}>
            Auto-Resolve
            {resolveStatus && (
              <span
                className={
                  resolveStatus.phase === "resolving"
                    ? s.resolveBusy
                    : s.resolveParked
                }
              >
                {" "}
                · {resolveStatus.ticket}{" "}
                {resolveStatus.phase === "resolving"
                  ? "…"
                  : resolveStatus.phase}
              </span>
            )}
          </span>
          <Toggle checked={autoResolve} onChange={toggleAutoResolve} />
        </div>
      </div>
      <ModeSwitch
        sequential={sequential}
        onChange={toggleSequential}
        maxActive={maxActive}
      />
    </div>
  );
}

// The concurrency POLICY — not part of the automation engine above (persisted
// per workspace, in force even when the engine is stopped, and it governs
// manual activation too). Framed as an explicit Parallel|Sequential mode switch
// rather than a lone "Sequential" toggle, whose "off" state read as ambiguous.
export function ModeSwitch({
  sequential,
  onChange,
  maxActive,
}: {
  sequential: boolean;
  onChange: (v: boolean) => void;
  maxActive: number;
}) {
  const hint = sequential
    ? "One ticket in flight at a time."
    : maxActive > 0
      ? `Up to ${maxActive} tickets in flight at once.`
      : "Multiple tickets in flight at once.";
  return (
    <div className={s.mode}>
      <div className={s.modeTitle}>MODE</div>
      <div className={s.segmented} role="radiogroup" aria-label="Concurrency mode">
        <button
          type="button"
          role="radio"
          aria-checked={!sequential}
          className={`${s.segment} ${!sequential ? s.segOn : ""}`}
          onClick={() => onChange(false)}
        >
          Parallel
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={sequential}
          className={`${s.segment} ${sequential ? s.segOn : ""}`}
          onClick={() => onChange(true)}
        >
          Sequential
        </button>
      </div>
      <div className={s.modeHint}>{hint}</div>
    </div>
  );
}

function SysInfo({
  mainBranch,
  activeCount,
  maxActive,
}: {
  mainBranch: string;
  activeCount: number;
  maxActive: number;
}) {
  return (
    <div className={s.sysinfo}>
      <div className={s.sysTitle}>WORKSPACE</div>
      <div className={s.sysBranch}>{mainBranch}</div>
      <div>
        {activeCount}
        {maxActive > 0 ? ` / ${maxActive}` : ""} active
      </div>
      <div>events.jsonl · live</div>
      {maxActive > 0 && (
        <div className={s.sysBar}>
          {Array.from({ length: maxActive }).map((_, i) => (
            <span
              key={i}
              className={`${s.sysSeg} ${i < activeCount ? s.on : ""}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
