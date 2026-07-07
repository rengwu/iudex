import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import type { RailCard, Ticket, Workspace, View } from "../types";
import { VIEWS } from "../types";
import { useNav, type Focus } from "../lib/nav";
import { useSessions, addSession } from "../lib/sessions";
import { useTicketTitles } from "../lib/agents";
import { IDEA_SKILLS } from "../lib/skills";
import { stateDot, ticketState } from "../lib/badges";
import { liveAgentFor } from "../lib/ticketActions";
import {
  workspaceActions,
  crashCandidates,
  timeAgo,
  type CrashedAgent,
  type HomeAction,
} from "../lib/home";
import type { Automation } from "../components/Sidebar";
import ViewHeader from "../components/ViewHeader";
import Button from "../components/Button";
import TabSwitcher from "../components/TabSwitcher";
import Badge from "../components/Badge";
import Dot from "../components/Dot";
import CanvasPanel from "../components/CanvasPanel";
import {
  useDashboardLayout,
  formatLayout,
  MIN_SIZE,
  PANEL_IDS,
  type PanelId,
} from "../lib/dashboardLayout";
import s from "./Dashboard.module.scss";

// Home. The job: open the app cold → within two seconds know the state of the
// line and the next things worth doing. A free-arrangement canvas of six
// read-derived modules — each an absolutely-positioned, draggable, resizable
// panel whose geometry persists to localStorage per workspace (see
// lib/dashboardLayout.ts). Everything is read-derived and *navigational* — the
// target views own the actions. Design: .context/prd/dashboard.md,
// .context/prd/dashboard-canvas.md.
const CANVAS_PAD = 8;

// Flip to true to reveal a dev-only "Copy layout" button beside "Reset layout":
// it copies the current arrangement as a pasteable DEFAULT_LAYOUT literal.
const DEBUG: boolean = true;
export default function Dashboard({
  ws,
  root,
  automation,
}: {
  ws: Workspace;
  root: string;
  automation: Automation;
}) {
  const { goTo } = useNav();
  const { sessions } = useSessions(root);
  const { titles } = useTicketTitles(root, ws);
  const seedRef = useRef<HTMLTextAreaElement>(null);

  // Crashed agents: probe only phase-matching sessions (impl on active, qa on
  // pending-qa) — a dead session whose ticket moved on is history, not a crash.
  const [crashed, setCrashed] = useState<CrashedAgent[]>([]);
  useEffect(() => {
    let stale = false;
    (async () => {
      const candidates = crashCandidates(ws, sessions);
      if (candidates.length === 0) {
        if (!stale) setCrashed([]);
        return;
      }
      // One tmux call for all liveness, not one per session (missing/unknown
      // ⇒ not crashed).
      const stats = new Map(
        (await api.sessionStatuses().catch(() => [])).map((s) => [s.name, s]),
      );
      const found: CrashedAgent[] = [];
      for (const sx of candidates) {
        const st = stats.get(sx.name);
        if (st && st.dead && st.exitCode !== null && st.exitCode !== 0) {
          found.push({
            ticket: sx.ticket!,
            session: sx.name,
            role: sx.role!,
          });
        }
      }
      if (!stale) setCrashed(found);
    })();
    return () => {
      stale = true;
    };
  }, [ws, sessions]);

  // Merge-readiness badges for the REVIEW column (preflight via rail_status).
  const [rail, setRail] = useState<RailCard[]>([]);
  useEffect(() => {
    const wts = ws.tickets
      .filter((t) => t.state === "pending-human-qa" && t.worktree)
      .map((t) => t.worktree!);
    if (wts.length === 0) {
      setRail([]);
      return;
    }
    api
      .railStatus(root, ws.mainBranch, wts)
      .then(setRail)
      .catch(() => setRail([]));
  }, [root, ws]);

  // Activity feed: refreshed by the same doorbell that refreshes `ws`.
  const [events, setEvents] = useState<api.EventRow[]>([]);
  useEffect(() => {
    api
      .recentEvents(root, 10)
      .then(setEvents)
      .catch(() => setEvents([]));
  }, [root, ws]);

  const actions = workspaceActions({
    ws,
    sessions,
    crashed,
    resolveStatus: automation.resolveStatus,
    sequential: automation.sequential,
    titles,
  });
  const runAction = (a: HomeAction) => {
    if (a.view) goTo(a.view, a.focus);
    else seedRef.current?.focus();
  };

  const { layout, setBox, commit, bringToFront, reset } =
    useDashboardLayout(root);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Canvas size derives from the panels so it grows to contain the furthest one
  // and the scroll container shows scrollbars automatically. Panels never read
  // the viewport size — this is what makes "viewport resize never reflows" hold.
  const boxes = Object.values(layout);
  const canvasW = CANVAS_PAD + Math.max(...boxes.map((b) => b.x + b.w));
  const canvasH = CANVAS_PAD + Math.max(...boxes.map((b) => b.y + b.h));

  // Dev-only: copy the live layout as a pasteable DEFAULT_LAYOUT literal (also
  // logged, as a fallback if the clipboard write is denied).
  const copyLayout = () => {
    const text = formatLayout(layout);
    console.log(text);
    void navigator.clipboard?.writeText(text).catch(() => {});
  };

  const panel = (id: PanelId, title: string, node: React.ReactNode) => (
    <CanvasPanel
      key={id}
      id={id}
      title={title}
      box={layout[id]}
      minW={MIN_SIZE[id].minW}
      minH={MIN_SIZE[id].minH}
      others={PANEL_IDS.filter((p) => p !== id).map((p) => layout[p])}
      scrollRef={scrollRef}
      onChange={(b) => setBox(id, b)}
      onCommit={commit}
      onFocus={() => bringToFront(id)}
    >
      {node}
    </CanvasPanel>
  );

  return (
    <div className={s.dash}>
      <ViewHeader dot={VIEWS.dashboard.dot} title="Dashboard">
        {DEBUG && (
          <Button variant="quiet" size="sm" onClick={copyLayout}>
            Copy layout
          </Button>
        )}
        <Button variant="quiet" size="sm" onClick={reset}>
          Reset layout
        </Button>
      </ViewHeader>
      <div className={s.scroll} ref={scrollRef}>
        <div
          className={s.canvas}
          style={{ minWidth: canvasW, minHeight: canvasH }}
        >
          {panel(
            "now",
            "WHAT'S NEXT",
            <NowStrip actions={actions} onRun={runAction} />,
          )}
          {panel(
            "pipe",
            "TICKET PIPELINE",
            <Pipeline
              ws={ws}
              sessions={sessions}
              titles={titles}
              rail={rail}
              goTo={goTo}
            />,
          )}
          {panel(
            "start",
            "CREATE WORK",
            <StartPanel root={root} seedRef={seedRef} goTo={goTo} />,
          )}
          {panel(
            "shells",
            "SHELLS",
            <ShellsPanel root={root} sessions={sessions} goTo={goTo} />,
          )}
          {panel(
            "auto",
            "AUTOMATION",
            <AutomationPanel
              automation={automation}
              maxActive={ws.maxActive}
            />,
          )}
          {panel(
            "activity",
            "ACTIVITY",
            <Activity events={events} goTo={goTo} ws={ws} />,
          )}
        </div>
      </div>
    </div>
  );
}

// ── NOW: equal-emphasis action chips, ordered by priority ───────────────────
const NOW_CAP = 6;

function NowStrip({
  actions,
  onRun,
}: {
  actions: HomeAction[];
  onRun: (a: HomeAction) => void;
}) {
  return (
    <div className={s.nowGrid}>
      {actions.slice(0, NOW_CAP).map((a) => (
        <button
          key={a.key}
          className={`${s.nowChip} ${s[`tone_${a.tone}`]}`}
          onClick={() => onRun(a)}
        >
          <Dot size={8} className={s.nowDot} />
          <span className={s.nowLabel}>{a.label}</span>
          <span className={s.nowArrow}>→</span>
        </button>
      ))}
      {actions.length > NOW_CAP && (
        <div className={s.nowMore}>+{actions.length - NOW_CAP} more</div>
      )}
    </div>
  );
}

// ── START: the funnel's front door, inline ───────────────────────────────────
function StartPanel({
  root,
  seedRef,
  goTo,
}: {
  root: string;
  seedRef: React.RefObject<HTMLTextAreaElement | null>;
  goTo: (v: View, f?: Focus) => void;
}) {
  const [skill, setSkill] = useState(IDEA_SKILLS[0].slug);
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const launch = async () => {
    setBusy(true);
    setErr(null);
    try {
      const sx = await api.spawnIdea(root, skill, seed);
      addSession(sx); // seed the pool so Agents can focus it before the next poll
      setSeed("");
      goTo("agents", { id: sx.name });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.start}>
      <textarea
        ref={seedRef}
        className={s.seed}
        placeholder="what should this project do next?"
        value={seed}
        spellCheck={false}
        onChange={(e) => setSeed(e.target.value)}
      />
      <div className={s.startRow}>
        <select
          className={s.skill}
          value={skill}
          onChange={(e) => setSkill(e.target.value)}
        >
          {IDEA_SKILLS.map((sk) => (
            <option key={sk.slug} value={sk.slug}>
              {sk.label}
            </option>
          ))}
        </select>
        <Button variant="primary" size="sm" disabled={busy} onClick={launch}>
          {busy ? "Launching…" : "Start chat"}
        </Button>
      </div>
      {err && <div className={s.err}>{err}</div>}
      <div className={s.startFoot}>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => goTo("tickets", { action: "compose" })}
        >
          Compose a single ticket
        </Button>
      </div>
    </div>
  );
}

// ── SHELLS: the live shell pool + the way in ─────────────────────────────────
function ShellsPanel({
  root,
  sessions,
  goTo,
}: {
  root: string;
  sessions: ReturnType<typeof useSessions>["sessions"];
  goTo: (v: View, f?: Focus) => void;
}) {
  const shells = sessions.filter((x) => x.kind === "shell");
  const openShell = async () => {
    try {
      const sess = await api.createShell(root);
      addSession(sess);
      goTo("terminal", { id: sess.name });
    } catch {
      // Terminal's own view surfaces tmux problems; still navigate.
      goTo("terminal");
    }
  };
  return (
    <div className={s.shells}>
      <div className={s.shellList}>
        {shells.length === 0 && <div className={s.quiet}>no open shells</div>}
        {shells.map((sh) => (
          <button
            key={sh.name}
            className={s.chip}
            onClick={() => goTo("terminal", { id: sh.name })}
          >
            <Dot className={s.shellDot} />
            <span className={s.chipId}>{sh.title || sh.name}</span>
          </button>
        ))}
      </div>
      <div className={s.shellFoot}>
        <Button variant="quiet" size="sm" onClick={openShell}>
          Open a shell
        </Button>
      </div>
    </div>
  );
}

// ── PIPELINE: the state machine as the assembly line it is (full width) ─────
const COLS: { label: string; state: string; view: View }[] = [
  { label: "QUEUED", state: "queued", view: "tickets" },
  { label: "ACTIVE", state: "active", view: "tickets" },
  { label: "QA", state: "pending-qa", view: "tickets" },
  { label: "REVIEW", state: "pending-human-qa", view: "review" },
  { label: "MERGED", state: "done", view: "archive" },
];
const CHIP_CAP = 6;

function Pipeline({
  ws,
  sessions,
  titles,
  rail,
  goTo,
}: {
  ws: Workspace;
  sessions: ReturnType<typeof useSessions>["sessions"];
  titles: Record<string, string>;
  rail: RailCard[];
  goTo: (v: View, f?: Focus) => void;
}) {
  const badgeFor = (t: Ticket) =>
    rail.find((r) => r.worktree === t.worktree)?.badge;
  const failed = ws.tickets.filter((t) => t.state === "failed");

  const chip = (t: Ticket, view: View) => {
    const title = titles[t.id];
    let hint: React.ReactNode = null;
    if (t.state === "queued") {
      hint = t.ready ? (
        <span className={s.ready}>ready</span>
      ) : (
        <span className={s.blocked}>⊘{t.blockedBy.join(",")}</span>
      );
    } else if (t.state === "active" || t.state === "pending-qa") {
      hint = liveAgentFor(t, sessions) ? (
        <span className={s.agentOn}>●</span>
      ) : null;
    } else if (t.state === "pending-human-qa") {
      const b = badgeFor(t);
      hint = b ? (
        <span className={`${s.mbadge} ${s[`m_${b}`]}`}>{b}</span>
      ) : null;
    } else if (t.state === "failed") {
      hint = <span className={s.blocked}>{t.qaRejects}× rejected</span>;
    }
    return (
      <button
        key={t.id}
        className={s.chip}
        onClick={() =>
          goTo(view, view === "archive" ? undefined : { id: t.id })
        }
      >
        <Dot color={stateDot(t.state)} />
        <span className={s.chipId}>{t.id}</span>
        {title && <span className={s.chipTitle}>{title}</span>}
        {hint}
      </button>
    );
  };

  return (
    <>
      <div className={s.cols}>
        {COLS.map((c) => {
          let items = ws.tickets.filter((t) => t.state === c.state);
          if (c.state === "done") items = [...items].reverse(); // recent first
          return (
            <div key={c.state} className={s.col}>
              <div className={s.colHead}>
                <Dot color={stateDot(c.state)} />
                {c.label}
                <span className={s.colN}>{items.length}</span>
              </div>
              {items.slice(0, CHIP_CAP).map((t) => chip(t, c.view))}
              {items.length > CHIP_CAP && (
                <button className={s.more} onClick={() => goTo(c.view)}>
                  +{items.length - CHIP_CAP} more
                </button>
              )}
            </div>
          );
        })}
      </div>
      {failed.length > 0 && (
        <div className={s.failedStrip}>
          <span className={s.failedLabel}>FAILED</span>
          {failed.map((t) => chip(t, "tickets"))}
        </div>
      )}
    </>
  );
}

// ── AUTOMATION: 2×2 latch grid + light-canvas MODE ──────────────────────────
function AutomationPanel({
  automation,
  maxActive,
}: {
  automation: Automation;
  maxActive: number;
}) {
  const latches: {
    label: string;
    hint: string;
    on: boolean;
    set: (v: boolean) => void;
  }[] = [
    {
      label: "Auto-Activate",
      hint: "Activate ready tickets and keep impl staffed (respawns after rejects).",
      on: automation.autoActivate,
      set: automation.toggleAutoActivate,
    },
    {
      label: "Auto-QA",
      hint: "Spawn a QA agent when a ticket reaches pending-qa.",
      on: automation.autoQA,
      set: automation.toggleAutoQA,
    },
    {
      label: "Auto-Retire",
      hint: "Kill agents once their phase has passed.",
      on: automation.autoRetire,
      set: automation.toggleAutoRetire,
    },
    {
      label: "Auto-Resolve",
      hint: "Pre-resolve merge conflicts on the first review-ready ticket.",
      on: automation.autoResolve,
      set: automation.toggleAutoResolve,
    },
  ];
  const rs = automation.resolveStatus;
  const seq = automation.sequential;
  return (
    <div className={s.auto}>
      <div className={s.latchGrid}>
        {latches.map((l) => (
          <button
            key={l.label}
            className={`${s.latch} ${l.on ? s.latchOn : ""}`}
            title={l.hint}
            onClick={() => l.set(!l.on)}
          >
            {l.label}
          </button>
        ))}
      </div>
      {rs && (
        <div className={rs.phase === "resolving" ? s.rsBusy : s.rsParked}>
          resolver: {rs.ticket}{" "}
          {rs.phase === "resolving" ? "working…" : rs.phase}
        </div>
      )}
      <div className={s.modeTitle}>MODE</div>
      <TabSwitcher
        variant="mode"
        ariaLabel="Concurrency mode"
        stretch
        tabs={[
          { label: "Parallel", value: false },
          { label: "Sequential", value: true },
        ]}
        value={seq}
        onChange={automation.toggleSequential}
      />
      <div className={s.modeHint}>
        {seq
          ? "One ticket in flight at a time."
          : maxActive > 0
            ? `Up to ${maxActive} tickets in flight at once.`
            : "Multiple tickets in flight at once."}
      </div>
    </div>
  );
}

// ── ACTIVITY: the event log, human-rendered with state badges ────────────────
function Activity({
  events,
  ws,
  goTo,
}: {
  events: api.EventRow[];
  ws: Workspace;
  goTo: (v: View, f?: Focus) => void;
}) {
  // Route a ticket to where its *current* state lives, not where the event was.
  const viewFor = (id: string): { view: View; focus?: { id: string } } => {
    const t = ws.tickets.find((x) => x.id === id);
    if (!t) return { view: "tickets" };
    if (t.state === "pending-human-qa")
      return { view: "review", focus: { id } };
    if (t.state === "done") return { view: "archive" };
    return { view: "tickets", focus: { id } };
  };
  return (
    <div className={s.evtList}>
      {events.length === 0 && <div className={s.quiet}>no events yet</div>}
      {events.map((e, i) => {
        const dest = viewFor(e.ticket);
        return (
          <button
            key={`${e.ts}-${i}`}
            className={s.evt}
            onClick={() => goTo(dest.view, dest.focus)}
          >
            <span className={s.evtTicket}>{e.ticket}</span>
            <span className={s.evtWhat}>{e.trigger || "→"}</span>
            <Badge kind="state" value={e.to}>
              {ticketState(e.to).short}
            </Badge>
            <span className={s.evtAge}>{timeAgo(e.ts)}</span>
          </button>
        );
      })}
    </div>
  );
}
