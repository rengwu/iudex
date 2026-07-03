import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import type { RailCard, Ticket, Workspace, View } from "../types";
import { VIEWS } from "../types";
import { useNav } from "../lib/nav";
import { useSessions, addSession } from "../lib/sessions";
import { useTicketTitles } from "../lib/agents";
import { IDEA_SKILLS } from "../lib/skills";
import { stateDot } from "../lib/badges";
import { liveAgentFor } from "../lib/ticketActions";
import {
  workspaceActions,
  crashCandidates,
  timeAgo,
  type CrashedAgent,
  type HomeAction,
} from "../lib/home";
import type { Automation } from "../components/Sidebar";
import { ModeSwitch } from "../components/Sidebar";
import ViewHeader from "../components/ViewHeader";
import Button from "../components/Button";
import Toggle from "../components/Toggle";
import s from "./Dashboard.module.scss";

// Home. The job: open the app cold → within two seconds know the state of the
// line and the single next thing worth doing. Glance first (NOW hero +
// pipeline + activity), control and starting work second (automation cluster,
// idea launcher). Everything here is read-derived and *navigational* — the
// target views own the actions. Design: .context/prd/dashboard.md.
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
      const found: CrashedAgent[] = [];
      for (const sx of crashCandidates(ws, sessions)) {
        try {
          const st = await api.sessionStatus(sx.name);
          if (st.dead && st.exitCode !== null && st.exitCode !== 0) {
            found.push({ ticket: sx.ticket!, session: sx.name, role: sx.role! });
          }
        } catch {
          // unknown → not crashed
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

  return (
    <div className={s.dash}>
      <ViewHeader dot={VIEWS.dashboard.dot} title="Dashboard" />
      <div className={s.grid}>
        <NowStrip actions={actions} onRun={runAction} />
        <StartPanel root={root} seedRef={seedRef} goTo={goTo} />
        <Pipeline ws={ws} sessions={sessions} titles={titles} rail={rail} goTo={goTo} />
        <AutomationPanel automation={automation} maxActive={ws.maxActive} />
        <Activity events={events} goTo={goTo} ws={ws} />
      </div>
    </div>
  );
}

// ── NOW: the hero + two runners ──────────────────────────────────────────────
function NowStrip({
  actions,
  onRun,
}: {
  actions: HomeAction[];
  onRun: (a: HomeAction) => void;
}) {
  const [hero, ...rest] = actions;
  const runners = rest.slice(0, 2);
  return (
    <section className={`${s.zone} ${s.now}`}>
      <div className={s.zoneTitle}>NOW</div>
      <button
        className={`${s.hero} ${s[`tone_${hero.tone}`]}`}
        onClick={() => onRun(hero)}
      >
        <span className={s.heroLabel}>{hero.label}</span>
        <span className={s.heroArrow}>→</span>
      </button>
      {runners.length > 0 && (
        <div className={s.runners}>
          then:
          {runners.map((r) => (
            <button key={r.key} className={s.runner} onClick={() => onRun(r)}>
              {r.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ── START: the funnel's front door, inline (no door-to-a-door modal) ────────
function StartPanel({
  root,
  seedRef,
  goTo,
}: {
  root: string;
  seedRef: React.RefObject<HTMLTextAreaElement | null>;
  goTo: (v: View, f?: { id: string }) => void;
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
  const openShell = async () => {
    try {
      await api.createShell(root);
    } catch {
      // Terminal's own view surfaces tmux problems; still navigate.
    }
    goTo("terminal");
  };

  return (
    <section className={`${s.zone} ${s.start}`}>
      <div className={s.zoneTitle}>START</div>
      <textarea
        ref={seedRef}
        className={s.seed}
        placeholder="seed an idea… (what should this project do next?)"
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
          {busy ? "Launching…" : "Shape idea"}
        </Button>
      </div>
      {err && <div className={s.err}>{err}</div>}
      <div className={s.links}>
        <button className={s.link} onClick={() => goTo("tickets")}>
          Compose a ticket ▸
        </button>
        <button className={s.link} onClick={openShell}>
          Open a shell ▸
        </button>
        <button className={s.link} onClick={() => goTo("specifications")}>
          Browse specs ▸
        </button>
      </div>
    </section>
  );
}

// ── PIPELINE: the state machine as the assembly line it is ──────────────────
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
  goTo: (v: View, f?: { id: string }) => void;
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
      hint = b ? <span className={`${s.mbadge} ${s[`m_${b}`]}`}>{b}</span> : null;
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
        <span className={s.chipDot} style={{ background: stateDot(t.state) }} />
        <span className={s.chipId}>{t.id}</span>
        {title && <span className={s.chipTitle}>{title}</span>}
        {hint}
      </button>
    );
  };

  return (
    <section className={`${s.zone} ${s.pipe}`}>
      <div className={s.zoneTitle}>PIPELINE</div>
      <div className={s.cols}>
        {COLS.map((c) => {
          let items = ws.tickets.filter((t) => t.state === c.state);
          if (c.state === "done") items = [...items].reverse(); // recent first
          return (
            <div key={c.state} className={s.col}>
              <div className={s.colHead}>
                <span className={s.colDot} style={{ background: stateDot(c.state) }} />
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
    </section>
  );
}

// ── AUTOMATION: the roomy twin of the sidebar transport (same state) ────────
function AutomationPanel({
  automation,
  maxActive,
}: {
  automation: Automation;
  maxActive: number;
}) {
  const rows: { label: string; hint: string; on: boolean; set: (v: boolean) => void }[] = [
    {
      label: "Auto-Activate",
      hint: "activate ready tickets + keep impl staffed (respawns after rejects)",
      on: automation.autoActivate,
      set: automation.toggleAutoActivate,
    },
    {
      label: "Auto-QA",
      hint: "spawn a QA agent when a ticket reaches pending-qa",
      on: automation.autoQA,
      set: automation.toggleAutoQA,
    },
    {
      label: "Auto-Retire",
      hint: "kill agents once their phase has passed",
      on: automation.autoRetire,
      set: automation.toggleAutoRetire,
    },
    {
      label: "Auto-Resolve",
      hint: "pre-resolve merge conflicts on the first review-ready ticket",
      on: automation.autoResolve,
      set: automation.toggleAutoResolve,
    },
  ];
  const rs = automation.resolveStatus;
  return (
    <section className={`${s.zone} ${s.auto}`}>
      <div className={s.zoneTitle}>AUTOMATION</div>
      {rows.map((r) => (
        <div key={r.label} className={s.autoRow}>
          <div className={s.autoText}>
            <span className={s.autoLabel}>{r.label}</span>
            <span className={s.autoHint}>{r.hint}</span>
          </div>
          <Toggle checked={r.on} onChange={r.set} />
        </div>
      ))}
      {rs && (
        <div className={rs.phase === "resolving" ? s.rsBusy : s.rsParked}>
          resolver: {rs.ticket} {rs.phase === "resolving" ? "working…" : rs.phase}
        </div>
      )}
      <div className={s.modeWrap}>
        <ModeSwitch
          sequential={automation.sequential}
          onChange={automation.toggleSequential}
          maxActive={maxActive}
        />
      </div>
    </section>
  );
}

// ── ACTIVITY: the event log, human-rendered ─────────────────────────────────
function Activity({
  events,
  ws,
  goTo,
}: {
  events: api.EventRow[];
  ws: Workspace;
  goTo: (v: View, f?: { id: string }) => void;
}) {
  // Route a ticket to where its *current* state lives, not where the event was.
  const viewFor = (id: string): { view: View; focus?: { id: string } } => {
    const t = ws.tickets.find((x) => x.id === id);
    if (!t) return { view: "tickets" };
    if (t.state === "pending-human-qa") return { view: "review", focus: { id } };
    if (t.state === "done") return { view: "archive" };
    return { view: "tickets", focus: { id } };
  };
  return (
    <section className={`${s.zone} ${s.activity}`}>
      <div className={s.zoneTitle}>ACTIVITY</div>
      {events.length === 0 && <div className={s.quiet}>no events yet</div>}
      {events.map((e, i) => {
        const dest = viewFor(e.ticket);
        return (
          <button
            key={`${e.ts}-${i}`}
            className={s.evt}
            onClick={() => goTo(dest.view, dest.focus)}
          >
            <span className={s.evtDot} style={{ background: stateDot(e.to) }} />
            <span className={s.evtTicket}>{e.ticket}</span>
            <span className={s.evtWhat}>
              {e.trigger || `→ ${e.to}`}
              {e.trigger && <span className={s.evtTo}> → {e.to}</span>}
            </span>
            <span className={s.evtAge}>{timeAgo(e.ts)}</span>
          </button>
        );
      })}
    </section>
  );
}
