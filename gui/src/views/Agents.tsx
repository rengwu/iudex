import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { useSessions } from "../lib/sessions";
import {
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
import { useTicketDocs } from "../lib/tickets";
import ChangedFilesDiff from "../components/ChangedFilesDiff";
import Badge from "../components/Badge";
import Button from "../components/Button";
import ViewHeader from "../components/ViewHeader";
import { agentStatusColor } from "../lib/badges";
import XtermPane from "./XtermPane";
import s from "./Agents.module.scss";

// A status as a colored dot + label — the rail/header status indicator. The dot
// color comes from the shared badge registry (single source for state colors).
function StatusDot({ status }: { status: AgentStatus }) {
  return (
    <>
      <span className={s.statusDot} style={{ background: agentStatusColor(status) }} />
      {STATUS_LABEL[status]}
    </>
  );
}

// Role chip — the shared <Badge> in role mode (monochrome; label conveys role).
function RoleChip({ role }: { role: string }) {
  return <Badge kind="role">{role}</Badge>;
}

// Master-detail over the agent sessions in the tmux pool. The left rail lists
// agents (no peeks); the right panel is the selected agent's cockpit — an
// interactive console plus its worktree diff and a ticket summary. Agents
// accumulate (a ticket can have several: impl, qa, resolve), each a distinct
// session; idea-shaping sessions are excluded (they're not ticket agents).
export default function Agents({
  ws,
  root,
  focusAgent,
  focusTab,
  onFocusHandled,
}: {
  ws: Workspace;
  root: string;
  focusAgent?: string | null;
  focusTab?: string | null;
  onFocusHandled?: () => void;
}) {
  const { sessions, available } = useSessions();
  const agents = sessions
    .filter((x) => x.kind === "agent")
    .sort(
      (a, b) =>
        (a.ticket ?? "").localeCompare(b.ticket ?? "") ||
        (a.started ?? "").localeCompare(b.started ?? ""),
    );

  const statuses = useAgentStatuses(agents, ws);

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

  const [selName, setSelName] = useState<string | null>(null);
  // Which tab the detail panel opens on for the next selection ("ticket" by
  // default; a cross-view "watch" can seed "console").
  const [seedTab, setSeedTab] = useState<Tab>("ticket");
  const selected = agents.find((a) => a.name === selName) ?? null;

  const select = (name: string, tab: Tab = "ticket") => {
    setSelName(name);
    setSeedTab(tab);
  };

  // Drop the selection if its agent vanished from the pool.
  useEffect(() => {
    if (selName && !agents.some((a) => a.name === selName)) setSelName(null);
  }, [agents, selName]);

  // Cross-view focus: select a specific agent when jumping from Tickets/Review,
  // opening the requested tab (e.g. Review "watch" → the resolver's console).
  useEffect(() => {
    if (focusAgent && agents.some((a) => a.name === focusAgent)) {
      select(focusAgent, (focusTab as Tab) || "ticket");
      onFocusHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAgent, focusTab, agents, onFocusHandled]);

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
      <ViewHeader dot="#5ccf5c" title="Agents">
        <span className={s.headerCount}>
          {agents.length} agent{agents.length === 1 ? "" : "s"}
        </span>
      </ViewHeader>
      <div className={s.root}>
        <aside className={s.rail}>
        <div className={s.list}>
          {agents.length === 0 && (
            <div className={`${s.empty} muted`}>
              No agents running. Activate a ticket to launch one.
            </div>
          )}
          {agents.map((a) => {
            const w = worktreeOf(a);
            const status = statuses[a.name] ?? "idle";
            return (
              <button
                key={a.name}
                className={`${s.card} ${a.name === selName ? s.active : ""}`}
                onClick={() => select(a.name)}
              >
                <span className={s.cardTop}>
                  <span className={s.cardId}>{a.ticket ?? "agent"}</span>
                  <span className={s.cardTitle}>{(w && titles[w]) || ""}</span>
                </span>
                <span className={s.cardBot}>
                  <RoleChip role={a.role ?? "agent"} />
                  <span className={s.cardStatus}>
                    <StatusDot status={status} />
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <div className={s.foot}>
          <span className="muted">
            {agents.length} agent{agents.length === 1 ? "" : "s"}
          </span>
          <Button variant="quiet" size="sm" onClick={clearFinished}>
            clear all finished
          </Button>
        </div>
      </aside>

      <div className={s.main}>
        {selected ? (
          <AgentDetail
            key={selected.name}
            agent={selected}
            ws={ws}
            root={root}
            initialTab={seedTab}
            status={statuses[selected.name] ?? "idle"}
            title={
              (worktreeOf(selected) && titles[worktreeOf(selected)!]) || ""
            }
            worktree={worktreeOf(selected)}
            onDismiss={() => setSelName(null)}
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
  initialTab,
  onDismiss,
  onKill,
}: {
  agent: Session;
  ws: Workspace;
  root: string;
  status: AgentStatus;
  title: string;
  worktree: string | null;
  initialTab: Tab;
  onDismiss: () => void;
  onKill: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  // Follow a new seed when the parent re-targets this same agent (e.g. a second
  // "watch"); a different agent remounts (keyed by name) and picks it up anyway.
  useEffect(() => setTab(initialTab), [initialTab]);
  // Mount the console only once it's actually been shown — a hidden mount fits
  // xterm at zero, attaches tmux at a default 80×24, and the later resize leaves
  // the screen dump garbled. Once shown it stays mounted (PTY persists across tab
  // switches); AgentDetail is keyed by agent, so this resets per agent.
  const [consoleSeen, setConsoleSeen] = useState(initialTab === "console");
  useEffect(() => {
    if (tab === "console") setConsoleSeen(true);
  }, [tab]);
  const ticket = agent.ticket
    ? (ws.tickets.find((t) => t.id === agent.ticket) ?? null)
    : null;

  return (
    <div className={s.detail}>
      <header className={s.head}>
        <span className={s.headId}>agent·{agent.ticket ?? "—"}</span>
        <RoleChip role={agent.role ?? "agent"} />
        {title && <span className={s.headTitle}>{title}</span>}
        {!title && <span className={s.headTitle} />}
        <span className={s.headStatus}>
          <StatusDot status={status} />
        </span>
        <Button
          variant="danger"
          size="sm"
          onClick={onKill}
          title="kill this agent"
        >
          kill agent
        </Button>
        <button
          className={s.x}
          title="dismiss panel (agent keeps running)"
          onClick={onDismiss}
        >
          ✕
        </button>
      </header>

      <nav className={s.tabs}>
        {(["ticket", "console", "worktree"] as Tab[]).map((t) => (
          <button
            key={t}
            className={`${s.tab} ${tab === t ? s.active : ""}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>

      <div className={s.content}>
        {/* Console stays mounted while this agent is selected so switching tabs
            never tears down its PTY; only its visibility toggles. */}
        <div
          className={s.console}
          style={{ display: tab === "console" ? "block" : "none" }}
        >
          {consoleSeen && <XtermPane session={agent.name} active={tab === "console"} />}
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
  const { docs, loading } = useTicketDocs(root, ticket);
  const cells: [string, string][] = [
    ["STATE", ticket.state],
    ["ROLE", role],
    ["WORKTREE", ticket.worktree || "—"],
    ["DEPS", ticket.deps.length ? ticket.deps.join(" ") : "—"],
    ["QA REJECTS", String(ticket.qaRejects)],
  ];
  return (
    <div className={s.pad}>
      <div className={s.metaGrid}>
        {cells.map(([label, val]) => (
          <div key={label} className={s.metaCell}>
            <div className={s.metaLabel}>{label}</div>
            <div className={s.metaVal}>{val}</div>
          </div>
        ))}
      </div>
      {loading && <span className="muted">loading…</span>}
      {!loading && docs?.brief?.trim() && (
        <pre className={s.doc}>{docs.brief}</pre>
      )}
      {!loading && !docs?.brief?.trim() && (
        <span className="muted">(no brief)</span>
      )}
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
            api.openInEditor(`${worktree}/${selFile}`).catch(
              () => {},
            )
          }
        >
          Open in editor
        </Button>
      }
    />
  );
}
