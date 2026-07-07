import { useEffect, useState, type ReactNode } from "react";
import * as api from "../lib/api";
import { addSession, useSessions } from "../lib/sessions";
import {
  agentBucket,
  canResume,
  canRestart,
  isFinished,
  STATUS_LABEL,
  useAgentStatuses,
  useBriefTitles,
  type AgentStatus,
} from "../lib/agents";
import type {
  FileChange,
  FileDiff,
  Session,
  Ticket,
  Workspace,
} from "../types";
import { VIEWS } from "../types";
import { useTicketDocs } from "../lib/tickets";
import { useNav, usePendingFocus } from "../lib/nav";
import ChangedFilesDiff from "../components/ChangedFilesDiff";
import Badge from "../components/Badge";
import Button from "../components/Button";
import IconButton from "../components/IconButton";
import TabSwitcher from "../components/TabSwitcher";
import OverflowMenu, { OverflowItem } from "../components/OverflowMenu";
import Dot from "../components/Dot";
import ViewHeader from "../components/ViewHeader";
import { agentStatusColor } from "../lib/badges";
import XtermPane from "./XtermPane";
import s from "./Agents.module.scss";

// A status as a colored dot + label — the rail/header status indicator. The dot
// color comes from the shared badge registry (single source for state colors).
// `labelFirst` puts the text before the dot (the rail rows right-align the
// status, so the dot sits at the card edge).
function StatusDot({
  status,
  labelFirst,
}: {
  status: AgentStatus;
  labelFirst?: boolean;
}) {
  const dot = <Dot color={agentStatusColor(status)} size={6} />;
  const label = STATUS_LABEL[status];
  return labelFirst ? (
    <>
      {label}
      {dot}
    </>
  ) : (
    <>
      {dot}
      {label}
    </>
  );
}

// Role chip — the shared <Badge> in role mode (monochrome; label conveys role).
function RoleChip({ role }: { role: string }) {
  return <Badge kind="role">{role}</Badge>;
}

// Auto-Retire countdown: an amber chip counting down to the sweep, plus a "Keep"
// button that pardons the session (never auto-marked again). Renders only while
// the deadline is in the future; `now` is a ticker so it recomputes ~every 30s.
// `compact` is the rail form: the chip shows just the countdown (amber already
// says "retiring"; the phrase moves to the tooltip) — the full form stays in
// the detail header. Keep is always visible in both forms.
function RetireChip({
  agent,
  now,
  onKeep,
  compact,
  dark,
}: {
  agent: Session;
  now: number;
  onKeep: () => void;
  compact?: boolean;
  dark?: boolean;
}) {
  if (!agent.retireAt) return null;
  const at = Number(agent.retireAt);
  if (!Number.isFinite(at) || at <= now) return null;
  const remaining = at - now;
  const label = remaining < 60_000 ? "<1m" : `${Math.ceil(remaining / 60_000)}m`;
  const phrase = `retiring in ${label}`;
  return (
    <>
      <span title={compact ? phrase : undefined}>
        <Badge bg="#e3cf9b" fg="#5a4a1f">
          {compact ? label : phrase}
        </Badge>
      </span>
      {/* Stop the click from bubbling to the rail card's select handler. */}
      <span onClick={(e) => e.stopPropagation()}>
        <Button
          variant={dark ? "quietDark" : "quiet"}
          size="sm"
          onClick={onKeep}
          title="keep this agent — cancel auto-retire"
        >
          Keep
        </Button>
      </span>
    </>
  );
}

// Master-detail over the agent sessions in the tmux pool. The left rail lists
// agents (no peeks); the right panel is the selected agent's cockpit — an
// interactive console plus its worktree diff and a ticket summary. Agents
// accumulate (a ticket can have several: impl, qa, resolve), each a distinct
// session; idea-shaping sessions are excluded (they're not ticket agents).
export default function Agents({
  ws,
  root,
}: {
  ws: Workspace;
  root: string;
}) {
  const focus = usePendingFocus("agents");
  const { sessions, available } = useSessions(root);
  // Both ticket agents (impl/qa/resolve) and idea-shaping agents live here — one
  // home for everything running (#8). Idea agents are ticket-less; the rendering
  // below special-cases them (an "idea" chip + the skill as the title). Terminal
  // is left to pure shells.
  const agents = sessions
    .filter((x) => x.kind === "agent" || x.kind === "idea")
    .sort(
      (a, b) =>
        (a.ticket ?? "").localeCompare(b.ticket ?? "") ||
        (a.started ?? "").localeCompare(b.started ?? ""),
    );

  const statuses = useAgentStatuses(agents, ws);
  // Rail-header breakdown: tally every agent into working / needs-you / finished
  // (exhaustive over AgentStatus); zero-count buckets are dropped so empty lines
  // never render.
  const tally = { working: 0, "needs-you": 0, finished: 0 };
  for (const a of agents) tally[agentBucket(statuses[a.name] ?? "idle")]++;
  const buckets = [
    { label: "working", n: tally.working },
    { label: "needs you", n: tally["needs-you"] },
    { label: "finished", n: tally.finished },
  ].filter((b) => b.n > 0);

  const worktreeOf = (a: Session) =>
    a.ticket
      ? (ws.tickets.find((t) => t.id === a.ticket)?.worktree ?? null)
      : null;
  const titles = useBriefTitles(
    agents.flatMap((a) => {
      const w = worktreeOf(a);
      return w ? [w] : [];
    }),
    ws,
  );

  // Retire countdown ticker: refresh the chip labels ~every 30s, but only while
  // at least one agent is actually retiring — the deadlines are static in the
  // poll snapshot, so this just advances "now".
  const anyRetiring = agents.some((a) => {
    if (!a.retireAt) return false;
    const at = Number(a.retireAt);
    return Number.isFinite(at) && at > Date.now();
  });
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!anyRetiring) return;
    setNowTick(Date.now());
    const h = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(h);
  }, [anyRetiring]);
  // Keep = pardon: clear the mark and opt the session out of future auto-marks.
  const keep = (name: string) => {
    api.clearRetire(name, true).catch(() => {});
  };

  const [selName, setSelName] = useState<string | null>(null);
  // The active detail tab, held here (not in AgentDetail) so it persists across
  // agent switches — AgentDetail is keyed by agent and remounts on each switch.
  const [tab, setTab] = useState<Tab>("console");
  const selected = agents.find((a) => a.name === selName) ?? null;

  // Select an agent AND seed its tab — used only by cross-view focus (watch/
  // spawn). Plain rail clicks select without touching the tab, so it persists.
  const select = (name: string, tab: Tab) => {
    setSelName(name);
    setTab(tab);
  };

  // Drop the selection if its agent vanished from the pool.
  useEffect(() => {
    if (selName && !agents.some((a) => a.name === selName)) setSelName(null);
  }, [agents, selName]);

  // Cross-view focus: select a specific agent when jumping from Tickets/Review,
  // opening the requested tab (e.g. Review "watch" → the resolver's console).
  useEffect(() => {
    const id = focus?.id;
    if (id && agents.some((a) => a.name === id)) {
      select(id, (focus.tab as Tab) || "console");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, agents]);

  const kill = async (name: string) => {
    await api.killSession(name).catch(() => {});
  };
  const clearFinished = async () => {
    await Promise.all(
      agents
        .filter((a) => isFinished(statuses[a.name]))
        .map((a) => kill(a.name)),
    );
  };

  if (available === false) {
    return (
      <div className="stub">
        <h2>Agents</h2>
        <p>
          tmux isn't on PATH — agent sessions live in the tmux pool. Install it
          with <code>brew install tmux</code> and reopen this view.
        </p>
      </div>
    );
  }

  return (
    <div className={s.view}>
      <ViewHeader dot={VIEWS.agents.dot} title="Agents" />
      <div className={s.root}>
        <aside className={s.rail}>
          <div className={s.railHead}>
            <div>
              {agents.length} agent{agents.length === 1 ? "" : "s"}
            </div>
            {buckets.map((b, i) => (
              <div key={b.label} className={s.railHeadChild}>
                <span className={s.treeMark}>
                  {i === buckets.length - 1 ? "└─ " : "├─ "}
                </span>
                <span>
                  {b.n} {b.label}
                </span>
                {b.label === "finished" && (
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={clearFinished}
                    style={{ marginLeft: "auto" }}
                  >
                    Clear
                  </Button>
                )}
              </div>
            ))}
          </div>
          <div className={s.list}>
            {agents.length === 0 && (
              <div className={`${s.empty} muted`}>
                No agents running. Activate a ticket to launch one.
              </div>
            )}
            {agents.map((a) => {
              const w = worktreeOf(a);
              const status = statuses[a.name] ?? "idle";
              const isIdea = a.kind === "idea";
              // The title has no room in the compact row; it rides the card's
              // tooltip (the detail header shows it in full).
              const title = isIdea ? (a.role ?? "") : (w && titles[w]) || "";
              const at = Number(a.retireAt);
              const retiring =
                !!a.retireAt && Number.isFinite(at) && at > nowTick;
              return (
                <button
                  key={a.name}
                  className={`${s.card} ${a.name === selName ? s.active : ""}`}
                  onClick={() => setSelName(a.name)}
                  title={title || undefined}
                >
                  <span className={s.cardTop}>
                    <span className={s.cardId}>
                      {isIdea ? "idea" : (a.ticket ?? "agent")}
                    </span>
                    <RoleChip role={isIdea ? "idea" : (a.role ?? "agent")} />
                    <span className={s.cardStatus}>
                      <StatusDot status={status} labelFirst />
                    </span>
                  </span>
                  {retiring && (
                    <span className={s.cardBot}>
                      <RetireChip
                        agent={a}
                        now={nowTick}
                        onKeep={() => keep(a.name)}
                        compact
                        dark={a.name === selName}
                      />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        <div className={s.main}>
          {selected ? (
            <AgentDetail
              key={selected.name}
              agent={selected}
              ws={ws}
              root={root}
              tab={tab}
              onTab={setTab}
              status={statuses[selected.name] ?? "idle"}
              title={
                (worktreeOf(selected) && titles[worktreeOf(selected)!]) || ""
              }
              worktree={worktreeOf(selected)}
              now={nowTick}
              onKeep={() => keep(selected.name)}
              onDismiss={() => setSelName(null)}
              onSelect={setSelName}
              onKill={async () => {
                await kill(selected.name);
                setSelName(null);
              }}
            />
          ) : (
            <div className={`${s.detailEmpty} muted`}>
              {agents.length > 0 ? "Select an agent." : ""}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type Tab = "ticket" | "console" | "worktree";

function AgentDetail({
  agent,
  ws,
  root,
  status,
  title,
  worktree,
  now,
  onKeep,
  tab,
  onTab,
  onDismiss,
  onSelect,
  onKill,
}: {
  agent: Session;
  ws: Workspace;
  root: string;
  status: AgentStatus;
  title: string;
  worktree: string | null;
  now: number;
  onKeep: () => void;
  tab: Tab;
  onTab: (t: Tab) => void;
  onDismiss: () => void;
  onSelect: (name: string) => void;
  onKill: () => void;
}) {
  // The active tab is parent-owned (persists across agent switches); this view
  // is controlled. Mount the console only once it's actually been shown — a
  // hidden mount fits xterm at zero, attaches tmux at a default 80×24, and the
  // later resize leaves the screen dump garbled. Once shown it stays mounted
  // (PTY persists across tab switches); AgentDetail is keyed by agent, so this
  // resets per agent.
  const [consoleSeen, setConsoleSeen] = useState(tab === "console");
  useEffect(() => {
    if (tab === "console") setConsoleSeen(true);
  }, [tab]);
  const ticket = agent.ticket
    ? (ws.tickets.find((t) => t.id === agent.ticket) ?? null)
    : null;

  // Stalled-agent remedy ladder (all manual — no auto-resume by design). `busy`
  // serializes the rungs so a double-click can't kill then race a respawn.
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Rung 1 — nudge the live REPL to retry/continue (harness-blind send-keys).
  const resume = async () => {
    setBusy(true);
    setActionErr(null);
    try {
      const nudge = await api.getResumeNudge(root);
      await api.resumeAgent(agent.name, nudge);
    } catch (e) {
      setActionErr(`resume failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  // Rungs 2 & 3 — kill the pane, then respawn a fresh agent. `clean` first hard-
  // resets the worktree (discarding the agent's work); plain Restart keeps it.
  const restart = async (clean: boolean) => {
    if (!agent.ticket) return;
    setBusy(true);
    setActionErr(null);
    try {
      // Stop the pane first so nothing writes while we reset / respawn.
      await api.killSession(agent.name);
      if (clean && worktree) {
        await api.resetWorktree(worktree, ws.mainBranch);
      }
      const next =
        agent.role === "resolve" && worktree
          ? await api.spawnResolver(root, agent.ticket, worktree)
          : await api.spawnAgent(root, agent.ticket, agent.role ?? "impl");
      addSession(next);
      onSelect(next.name);
    } catch (e) {
      // The pane is already gone; leave the panel so the error is visible.
      setActionErr(`restart failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.detail}>
      <header className={s.head}>
        <span className={s.headId}>
          {agent.kind === "idea"
            ? `idea·${agent.role ?? "—"}`
            : `agent·${agent.ticket ?? "—"}`}
        </span>
        <RoleChip role={agent.kind === "idea" ? "idea" : (agent.role ?? "agent")} />
        {title && <span className={s.headTitle}>{title}</span>}
        {!title && <span className={s.headTitle} />}
        <span className={s.headStatus}>
          <StatusDot status={status} />
        </span>
        <RetireChip agent={agent} now={now} onKeep={onKeep} />
        {/* The one contextual primary stays on the bar; every other action —
            Restart, the destructive Restart clean, and Kill — lives in the ⋯
            menu so the row reads as a calm, uniform toolbar (one button style). */}
        {canResume(status) && (
          <Button
            variant="quiet"
            size="sm"
            disabled={busy}
            onClick={resume}
            title="nudge the live agent to retry / continue (sends the configured line + Enter)"
          >
            Resume
          </Button>
        )}
        <OverflowMenu direction="down" size="sm" disabled={busy}>
          {canRestart(agent) && (
            <OverflowItem
              onClick={() => restart(false)}
              title="kill and respawn a fresh agent — keeps the worktree's progress"
            >
              Restart
            </OverflowItem>
          )}
          {canRestart(agent) && worktree && (
            <OverflowItem
              danger
              onClick={() => {
                if (
                  window.confirm(
                    `Restart clean will hard-reset ${agent.ticket}'s worktree to ${ws.mainBranch} and permanently discard the agent's work. Continue?`,
                  )
                ) {
                  restart(true);
                }
              }}
            >
              Restart clean…
            </OverflowItem>
          )}
          <OverflowItem danger onClick={onKill}>
            Kill agent
          </OverflowItem>
        </OverflowMenu>
        <IconButton
          title="dismiss panel (agent keeps running)"
          onClick={onDismiss}
          style={{ marginLeft: 2 }}
        />
      </header>
      {actionErr && <div className={`${s.actionErr} error`}>{actionErr}</div>}

      <TabSwitcher
        variant="tabs"
        value={tab}
        onChange={onTab}
        tabs={(["console", "ticket", "worktree"] as Tab[]).map((t) => ({
          value: t,
          label: t.slice(0, 1).toLocaleUpperCase() + t.slice(1),
        }))}
      />

      <div className={s.content}>
        {/* Console stays mounted while this agent is selected so switching tabs
            never tears down its PTY; only its visibility toggles. */}
        <div
          className={s.console}
          style={{ display: tab === "console" ? "block" : "none" }}
        >
          {consoleSeen && (
            <XtermPane session={agent.name} active={tab === "console"} />
          )}
        </div>
        {tab === "worktree" &&
          (worktree ? (
            <WorktreePanel worktree={worktree} mainBranch={ws.mainBranch} />
          ) : (
            <div className={`${s.pad} muted`}>This agent has no worktree.</div>
          ))}
        {tab === "ticket" &&
          (ticket ? (
            <TicketBrief root={root} ticket={ticket} role={agent.role ?? "—"} />
          ) : (
            <div className={`${s.pad} muted`}>No ticket for this agent.</div>
          ))}
      </div>
    </div>
  );
}

// The ticket brief shown in the Agents panel ticket tab — a simple read-only
// display of the brief text, without the full TicketDetail panel chrome.
function TicketBrief({
  root,
  ticket,
  role,
}: {
  root: string;
  ticket: Ticket;
  role: string;
}) {
  const { goTo } = useNav();
  const { docs, loading } = useTicketDocs(root, ticket);
  const cells: [string, ReactNode][] = [
    ["state", <Badge kind="state" value={ticket.state} />],
    ["role", role],
    ["worktree", ticket.worktree || "—"],
    ["deps", ticket.deps.length ? ticket.deps.join(" ") : "—"],
    ["qa rejects", String(ticket.qaRejects)],
  ];
  return (
    <div className={s.pad}>
      <div className={s.section}>
        <div className={s.sectionHead}>
          <span className={s.sectionTitle}>
            ticket · <span className={s.sectionTitleId}>{ticket.id}</span>
          </span>
          <div className={s.headBtns}>
            {ticket.state === "pending-human-qa" && (
              <Button
                variant="review"
                size="sm"
                onClick={() => goTo("review", { id: ticket.id })}
              >
                Go to Review
              </Button>
            )}
            <Button
              variant="quiet"
              size="sm"
              onClick={() => goTo("tickets", { id: ticket.id })}
            >
              Go to Ticket
            </Button>
          </div>
        </div>
        <div className={s.metaMap}>
          {cells.map(([label, val]) => (
            <div key={label} className={s.metaRow}>
              <span className={s.metaKey}>{label}</span>
              <span className={s.metaVal}>{val}</span>
            </div>
          ))}
        </div>
      </div>
      <div className={s.section}>
        <div className={s.sectionLabel}>brief</div>
        {loading && <span className="muted">loading…</span>}
        {!loading && docs?.brief?.trim() && (
          <pre className={s.doc}>{docs.brief}</pre>
        )}
        {!loading && !docs?.brief?.trim() && (
          <span className="muted">(no brief)</span>
        )}
      </div>
    </div>
  );
}

// The selected agent's worktree changes vs main (two-dot, so the agent's
// uncommitted progress shows). Fetches; the shared ChangedFilesDiff renders.
function WorktreePanel({
  worktree,
  mainBranch,
}: {
  worktree: string;
  mainBranch: string;
}) {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [selFile, setSelFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .worktreeChanges(worktree, mainBranch)
      .then((c) => {
        if (!alive) return;
        setChanges(c);
        // Default-select the first file so a diff shows immediately.
        setSelFile((prev) =>
          c.some((x) => x.path === prev) ? prev : (c[0]?.path ?? null),
        );
      })
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, [worktree, mainBranch]);

  useEffect(() => {
    if (!selFile) {
      setDiff(null);
      return;
    }
    let alive = true;
    api
      .worktreeFileDiff(worktree, selFile, mainBranch)
      .then((d) => alive && setDiff(d))
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, [worktree, selFile, mainBranch]);

  return (
    <ChangedFilesDiff
      changes={changes}
      selected={selFile}
      onSelect={setSelFile}
      diff={diff}
      error={err}
      noChangesHint="no changes vs main"
      fileActions={
        <Button
          variant="quiet"
          size="sm"
          onClick={() =>
            api.openInEditor(`${worktree}/${selFile}`).catch(() => {})
          }
        >
          Open in editor
        </Button>
      }
    />
  );
}
