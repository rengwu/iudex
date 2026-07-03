import {
  RAIL_VIEWS,
  RAIL_SECONDARY,
  type View,
  type Workspace,
  type Session,
} from "../types";
import SectionHeader from "./SectionHeader";
import Toggle from "./Toggle";
import s from "./Sidebar.module.scss";

type Automation = {
  autoActivate: boolean;
  autoQA: boolean;
  autoRetire: boolean;
  sequential: boolean;
  toggleAutoActivate: (v: boolean) => void;
  toggleAutoQA: (v: boolean) => void;
  toggleAutoRetire: (v: boolean) => void;
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
        <PipelineSummary pipeline={pipeline} />
        <TransportControls automation={automation} />
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

function TransportControls({ automation }: { automation: Automation }) {
  const {
    autoActivate,
    autoQA,
    autoRetire,
    sequential,
    toggleAutoActivate,
    toggleAutoQA,
    toggleAutoRetire,
    toggleSequential,
  } = automation;
  const allOn = autoActivate && autoQA && autoRetire;
  const allOff = !autoActivate && !autoQA && !autoRetire;
  return (
    <div className={s.transport}>
      <div className={s.transportBtns}>
        <span
          className={`${s.tBtn} ${allOn ? s.tActive : ""}`}
          title="Start automation (Auto-Activate + Auto-QA + Auto-Retire on)"
          onClick={() => {
            toggleAutoActivate(true);
            toggleAutoQA(true);
            toggleAutoRetire(true);
          }}
        >
          <span className={s.playTri} />
        </span>
        <span
          className={`${s.tBtn} ${allOff ? s.tActive : ""}`}
          title="Stop automation (all off)"
          onClick={() => {
            toggleAutoActivate(false);
            toggleAutoQA(false);
            toggleAutoRetire(false);
          }}
        >
          <span className={s.stopSq} />
        </span>
      </div>
      <div className={s.toggles}>
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
        {/* Policy, not engine: persisted per workspace, in force even with the
            engine stopped, untouched by the play/stop buttons. */}
        <div
          className={s.toggleRow}
          title="At most one ticket in flight (active / QA / your review). Persisted for this workspace; applies to manual activation too."
        >
          <span className={s.toggleLabel}>Sequential</span>
          <Toggle checked={sequential} onChange={toggleSequential} />
        </div>
      </div>
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
