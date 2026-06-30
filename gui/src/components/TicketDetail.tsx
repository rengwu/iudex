import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import type { Session, Ticket, Workspace } from "../types";
import { useTicketDocs } from "../lib/tickets";
import { useNav } from "../lib/nav";
import { useSessions } from "../lib/sessions";
import { nextAction, type Intent } from "../lib/ticketActions";
import {
  useAgentStatuses,
  STATUS_LABEL,
  type AgentStatus,
} from "../lib/agents";
import Badge from "./Badge";
import TabSwitcher from "./TabSwitcher";
import s from "./TicketDetail.module.scss";

type LogTab = "impl" | "qa";

// Extract the title (first `# Heading` line) and body (everything else) from a
// raw brief markdown string.
function parseBrief(raw: string): { title: string; body: string } {
  const lines = raw.split("\n");
  const hi = lines.findIndex((l) => l.startsWith("# "));
  if (hi === -1) return { title: "", body: raw };
  const title = lines[hi].slice(2).trim();
  const body = lines
    .filter((_, i) => i !== hi)
    .join("\n")
    .replace(/^\n+/, "");
  return { title, body };
}

function serializeBrief(title: string, body: string): string {
  return title ? `# ${title}\n\n${body}` : body;
}

// Dot color for a synthesized agent status.
function dotClass(status: AgentStatus): string {
  switch (status) {
    case "working":
    case "resolved":
      return s.green;
    case "awaiting-finish":
    case "review-ready":
    case "flagged":
      return s.blue;
    case "crashed":
    case "gone":
      return s.red;
    default:
      return s.grey;
  }
}

// Full ticket detail panel: header + title + sections. The caller provides
// onClose and onSaved; cross-view jumps (Agents / Review) go through the nav
// context's goTo. `ws` is needed for state-aware actions.
export default function TicketDetail({
  root,
  ticket,
  ws,
  onClose,
  onSaved,
}: {
  root: string;
  ticket: Ticket;
  ws: Workspace;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { goTo } = useNav();
  const { docs, loading } = useTicketDocs(root, ticket);
  const { sessions } = useSessions(root);
  const agentSessions = sessions.filter(
    (s) => s.kind === "agent" && s.ticket === ticket.id,
  );
  const statuses = useAgentStatuses(agentSessions, ws);

  const isQueued = ticket.state === "queued";

  // Editable state — only populated/used when queued.
  const parsed = docs ? parseBrief(docs.brief) : { title: "", body: "" };
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [saveStatus, setSaveStatus] = useState<
    "" | "saving" | "saved" | "error"
  >("");
  const [logTab, setLogTab] = useState<LogTab>("impl");
  // The brief content last persisted; autosave skips writes that match it, so a
  // freshly-loaded ticket — and the trailing debounce after a blur — don't write.
  const lastSaved = useRef("");

  // Sync edit fields when docs load/change (queued only); reset the autosave
  // baseline so the load itself isn't mistaken for a pending edit.
  useEffect(() => {
    if (isQueued && docs) {
      setEditTitle(parsed.title);
      setEditBody(parsed.body);
      lastSaved.current = serializeBrief(parsed.title, parsed.body);
      setSaveStatus("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, ticket.id]);

  // Persist the current edits unless they already match what's on disk.
  const save = useCallback(async () => {
    const content = serializeBrief(editTitle, editBody);
    if (content === lastSaved.current) return;
    setSaveStatus("saving");
    try {
      await api.writeQueueBrief(root, ticket.id, content);
      lastSaved.current = content;
      setSaveStatus("saved");
      onSaved?.(); // refresh the list views' titles (no event → no doorbell)
    } catch {
      setSaveStatus("error");
    }
  }, [root, ticket.id, editTitle, editBody, onSaved]);

  // Autosave: fire 1.5s after the last keystroke (each edit resets the timer).
  // Blur flushes immediately via onBlur on the fields below; both go through
  // `save`, which no-ops when nothing changed, so the orderings can't double-write.
  useEffect(() => {
    if (!isQueued || !docs) return;
    if (serializeBrief(editTitle, editBody) === lastSaved.current) return;
    const t = setTimeout(save, 1500);
    return () => clearTimeout(t);
  }, [editTitle, editBody, isQueued, docs, save]);

  const dirty =
    isQueued &&
    !!docs &&
    serializeBrief(editTitle, editBody) !== lastSaved.current;

  // State-aware actions (rendered in the footer).
  const [actionBusy, setActionBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, closeAfter = false) => {
    setActionBusy(true);
    try {
      await fn();
    } finally {
      setActionBusy(false);
    }
    if (closeAfter) onClose();
  };

  const displayTitle = isQueued ? editTitle : parsed.title;
  const hasWorktree = !!ticket.worktree;
  const hasLog = hasWorktree && !!docs?.log?.trim();
  const hasQaReview = hasWorktree && !!docs?.review?.trim();

  return (
    <div className={s.root}>
      {/* Header */}
      <div className={s.header}>
        <span className={s.headId}>{ticket.id}</span>
        <Badge kind="state" value={ticket.state} />
        <button className={s.headClose} onClick={onClose} title="close">
          ✕
        </button>
      </div>

      {/* Title */}
      <div className={s.titleRow}>
        {isQueued ? (
          <input
            className={s.titleInput}
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={save}
            placeholder="ticket title"
          />
        ) : (
          <span className={s.titleText}>
            {displayTitle || <span className="muted">(no title)</span>}
          </span>
        )}
      </div>

      {/* Scrollable body */}
      <div className={s.body}>
        {/* Brief */}
        <div style={{ marginBottom: "6px" }}>
          <Section label="brief">
            {loading ? (
              <span className={s.placeholder}>loading…</span>
            ) : isQueued ? (
              <textarea
                className={s.briefTextarea}
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                onBlur={save}
                placeholder="markdown brief…"
                rows={6}
              />
            ) : parsed.body.trim() ? (
              <pre className={s.briefDoc}>{parsed.body}</pre>
            ) : (
              <span className={s.placeholder}>(no brief)</span>
            )}
          </Section>
        </div>

        {/* Info + Agents */}
        <div className={s.grid2}>
          <Section label="info">
            {ticket.deps.length > 0 && (
              <div className={s.kv}>
                <span>prerequisites</span>
                <div className={s.chips}>
                  {ticket.deps.map((d) => (
                    <span key={d} className={s.chip}>
                      {d}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {(ticket.blocks ?? []).length > 0 && (
              <div className={s.kv}>
                <span>blocks</span>
                <div className={s.chips}>
                  {(ticket.blocks ?? []).map((d) => (
                    <span key={d} className={s.chip}>
                      {d}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {ticket.worktree && (
              <div className={s.kv}>
                <span>worktree</span>
                <span className={s.wt}>{ticket.worktree}</span>
              </div>
            )}
            {ticket.qaRejects > 0 && (
              <div className={s.kv}>
                <span>qa rejects</span>
                <span>{ticket.qaRejects}</span>
              </div>
            )}
            {ticket.deps.length === 0 &&
              (ticket.blocks ?? []).length === 0 &&
              !ticket.worktree &&
              ticket.qaRejects === 0 && (
                <span className={s.placeholder}>no metadata yet</span>
              )}
          </Section>

          <Section label="agents">
            {agentSessions.length === 0 ? (
              <span className={s.placeholder}>no agents yet</span>
            ) : (
              agentSessions.map((a) => {
                const status = statuses[a.name] ?? "idle";
                return (
                  <div
                    key={a.name}
                    className={s.agentRow}
                    onClick={() => goTo("agents", { id: a.name })}
                    title="open in Agents view"
                  >
                    <span className={`${s.dot} ${dotClass(status)}`} />
                    <span className={s.agentRole}>{a.role ?? "agent"}</span>
                    <span className={s.agentStatus}>
                      {STATUS_LABEL[status]}
                    </span>
                  </div>
                );
              })
            )}
          </Section>
        </div>

        {/* Log */}
        <Section label="log">
          {hasWorktree && (
            <div style={{ marginBottom: 6 }}>
              <TabSwitcher
                tabs={[
                  { label: "Implement", value: "impl" },
                  { label: "QA", value: "qa" },
                ]}
                value={logTab}
                onChange={(v) => setLogTab(v as LogTab)}
                fontSize="11px"
              />
            </div>
          )}
          {!hasWorktree ? (
            <span className={s.placeholder}>
              no log until ticket is activated
            </span>
          ) : logTab === "impl" ? (
            hasLog ? (
              <pre className={s.logDoc}>{docs!.log}</pre>
            ) : (
              <span className={s.placeholder}>(no implementation log yet)</span>
            )
          ) : hasQaReview ? (
            <pre className={s.logDoc}>{docs!.review}</pre>
          ) : (
            <span className={s.placeholder}>(no QA review yet)</span>
          )}
        </Section>
      </div>

      {/* Footer: state actions + autosave status (queued, debounced + blur).
          Rendered for terminal tickets too, so the panel shows the same muted
          "✓ merged" note the table does (full table/panel symmetry). */}
      <div className={s.footer}>
        {isQueued && (
          <span className={s.saveStatus}>
            {saveStatus === "saving"
              ? "saving…"
              : saveStatus === "error"
                ? "✗ save failed"
                : dirty
                  ? "unsaved…"
                  : saveStatus === "saved"
                    ? "✓ saved"
                    : ""}
          </span>
        )}
        <div className={s.footerActions}>
          <FooterActions
            ticket={ticket}
            root={root}
            busy={actionBusy}
            sessions={sessions}
            onAct={act}
          />
        </div>
      </div>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={s.section}>
      <span className={s.sectionLabel}>{label}</span>
      {children}
    </div>
  );
}

function FooterActions({
  ticket,
  root,
  busy,
  sessions,
  onAct,
}: {
  ticket: Ticket;
  root: string;
  busy: boolean;
  sessions: Session[];
  onAct: (fn: () => Promise<unknown>, closeAfter?: boolean) => void;
}) {
  const { goTo } = useNav();
  const run = (args: string[], closeAfter = false) =>
    onAct(() => api.runIudex(root, args), closeAfter);
  const spawnAndJump = (role: string) =>
    onAct(async () => {
      const s = await api.spawnAgent(root, ticket.id, role);
      goTo("agents", { id: s.name });
    });

  // Same primary action the table row shows — single-sourced in `nextAction`.
  const a = nextAction(ticket, sessions);
  // Map intent → this panel's handler (busy/nav are panel-local; the *choice*
  // is shared). `note` renders muted text rather than a button.
  const runIntent = (intent: Intent) => {
    switch (intent) {
      case "activate-impl":
        return onAct(async () => {
          await api.runIudex(root, ["activate", ticket.id]);
          const s = await api.spawnAgent(root, ticket.id, "impl");
          goTo("agents", { id: s.name });
        });
      case "resume-impl":
      case "open-agent":
        return spawnAndJump("impl");
      case "spawn-qa":
        return spawnAndJump("qa");
      case "review":
        return goTo("review", { id: ticket.id });
      case "retry":
        return run(["retry", ticket.id]);
      case "note":
        return;
    }
  };

  const isTerminal = ticket.state === "done" || ticket.state === "removed";

  return (
    <>
      {a.variant ? (
        <button
          className={s.footerBtn}
          disabled={busy}
          onClick={() => runIntent(a.intent)}
        >
          {a.label}
        </button>
      ) : a.label ? (
        <span className={s.footerNote}>{a.label}</span>
      ) : null}
      {/* Destructive / dangerous (and other tucked-away) actions live behind
          the overflow menu — non-terminal only (nothing to do once done/removed).
          Finish lives here, not as a primary button: ideally the impl agent runs
          `iudex finish` itself; this is the manual escape hatch. */}
      {!isTerminal && (
        <FooterOverflow>
          {ticket.state === "active" && (
            <button
              className={s.menuItem}
              disabled={busy}
              onClick={() => run(["finish", ticket.id])}
            >
              Finish
            </button>
          )}
          <button
            className={`${s.menuItem} ${s.danger}`}
            disabled={busy}
            onClick={() => run(["remove", ticket.id], true)}
          >
            Remove
          </button>
        </FooterOverflow>
      )}
    </>
  );
}

// Three-dot overflow for the footer's destructive/dangerous actions. Pass the
// danger buttons as children (styled with `s.menuItem`/`s.danger`); the menu
// opens upward from the footer, closes on outside-click, and dismisses itself
// after any item click. This is the base hook for future dangerous actions —
// add more children here rather than as inline footer buttons.
function FooterOverflow({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className={s.menuWrap} ref={ref}>
      <button
        className={s.menuBtn}
        onClick={() => setOpen((o) => !o)}
        title="more actions"
      >
        ⋮
      </button>
      {open && (
        <div className={s.menu} onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
