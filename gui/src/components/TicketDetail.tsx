import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Ticket, Workspace } from "../types";
import { useTicketDocs } from "../lib/tickets";
import { useSessions } from "../lib/sessions";
import { useAgentStatuses, STATUS_LABEL, type AgentStatus } from "../lib/agents";
import StateBadge from "./StateBadge";
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
    case "working": return s.green;
    case "awaiting-finish":
    case "review-ready": return s.blue;
    case "crashed":
    case "gone": return s.red;
    default: return s.grey;
  }
}

// Full ticket detail panel: header + title + sections. The caller provides
// onClose and onJumpToAgent so the panel can close itself and cross-link into
// the Agents view. `ws` is needed for state-aware actions.
export default function TicketDetail({
  root,
  ticket,
  ws,
  onClose,
  onJumpToAgent,
}: {
  root: string;
  ticket: Ticket;
  ws: Workspace;
  onClose: () => void;
  onJumpToAgent: (sessionName: string) => void;
}) {
  const { docs, loading } = useTicketDocs(root, ticket);
  const { sessions } = useSessions();
  const agentSessions = sessions.filter(
    (s) => s.kind === "agent" && s.ticket === ticket.id,
  );
  const statuses = useAgentStatuses(agentSessions, ws);

  const isQueued = ticket.state === "queued";
  const isTerminal = ticket.state === "done" || ticket.state === "removed";

  // Editable state — only populated/used when queued.
  const parsed = docs ? parseBrief(docs.brief) : { title: "", body: "" };
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [saveStatus, setSaveStatus] = useState<"" | "saved" | "error">("");
  const [saving, setSaving] = useState(false);
  const [logTab, setLogTab] = useState<LogTab>("impl");

  // Sync edit fields when docs load/change (queued only).
  useEffect(() => {
    if (isQueued && docs) {
      setEditTitle(parsed.title);
      setEditBody(parsed.body);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs, ticket.id]);

  const save = async () => {
    setSaving(true);
    setSaveStatus("");
    try {
      await invoke("write_queue_brief", {
        root,
        id: ticket.id,
        content: serializeBrief(editTitle, editBody),
      });
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  };

  // Actions menu
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const [actionBusy, setActionBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, closeAfter = false) => {
    setMenuOpen(false);
    setActionBusy(true);
    try { await fn(); } finally { setActionBusy(false); }
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
        <StateBadge state={ticket.state} />
        <button className={s.headClose} onClick={onClose} title="close">✕</button>
      </div>

      {/* Title + actions menu */}
      <div className={s.titleRow}>
        {isQueued ? (
          <input
            className={s.titleInput}
            value={editTitle}
            onChange={(e) => { setEditTitle(e.target.value); setSaveStatus(""); }}
            placeholder="ticket title"
          />
        ) : (
          <span className={s.titleText}>{displayTitle || <span className="muted">(no title)</span>}</span>
        )}
        {!isTerminal && (
          <div className={s.menuWrap} ref={menuRef}>
            <button className={s.menuBtn} onClick={() => setMenuOpen((o) => !o)} title="actions">
              ⋮
            </button>
            {menuOpen && (
              <ActionsMenu
                ticket={ticket}
                root={root}
                busy={actionBusy}
                onAct={act}
                onJumpToAgent={onJumpToAgent}
              />
            )}
          </div>
        )}
      </div>

      {/* Scrollable body */}
      <div className={s.body}>
        {/* Brief */}
        <Section label="brief">
          {loading ? (
            <span className={s.placeholder}>loading…</span>
          ) : isQueued ? (
            <textarea
              className={s.briefTextarea}
              value={editBody}
              onChange={(e) => { setEditBody(e.target.value); setSaveStatus(""); }}
              placeholder="markdown brief…"
              rows={6}
            />
          ) : docs?.brief?.trim() ? (
            <pre className={s.briefDoc}>{docs.brief}</pre>
          ) : (
            <span className={s.placeholder}>(no brief)</span>
          )}
        </Section>

        {/* Info + Agents */}
        <div className={s.grid2}>
          <Section label="info">
            {ticket.deps.length > 0 && (
              <div className={s.kv}>
                <span>prerequisites</span>
                <div className={s.chips}>
                  {ticket.deps.map((d) => <span key={d} className={s.chip}>{d}</span>)}
                </div>
              </div>
            )}
            {(ticket.blocks ?? []).length > 0 && (
              <div className={s.kv}>
                <span>blocks</span>
                <div className={s.chips}>
                  {(ticket.blocks ?? []).map((d) => <span key={d} className={s.chip}>{d}</span>)}
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
            {ticket.deps.length === 0 && (ticket.blocks ?? []).length === 0 && !ticket.worktree && ticket.qaRejects === 0 && (
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
                    onClick={() => onJumpToAgent(a.name)}
                    title="open in Agents view"
                  >
                    <span className={`${s.dot} ${dotClass(status)}`} />
                    <span className={s.agentRole}>{a.role ?? "agent"}</span>
                    <span className={s.agentStatus}>{STATUS_LABEL[status]}</span>
                  </div>
                );
              })
            )}
          </Section>
        </div>

        {/* Log */}
        <Section label="log">
          <div className={s.logTabs}>
            <button
              className={`${s.logTab} ${logTab === "impl" ? s.active : ""}`}
              onClick={() => setLogTab("impl")}
              disabled={!hasWorktree}
            >
              impl
            </button>
            <button
              className={`${s.logTab} ${logTab === "qa" ? s.active : ""}`}
              onClick={() => setLogTab("qa")}
              disabled={!hasWorktree}
            >
              qa
            </button>
          </div>
          {!hasWorktree ? (
            <span className={s.placeholder}>no log until ticket is activated</span>
          ) : logTab === "impl" ? (
            hasLog ? (
              <pre className={s.logDoc}>{docs!.log}</pre>
            ) : (
              <span className={s.placeholder}>(no impl log yet)</span>
            )
          ) : (
            hasQaReview ? (
              <pre className={s.logDoc}>{docs!.review}</pre>
            ) : (
              <span className={s.placeholder}>(no QA review yet)</span>
            )
          )}
        </Section>
      </div>

      {/* Save footer — queued only */}
      {isQueued && (
        <div className={s.footer}>
          <button className={s.saveBtn} disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
          {saveStatus === "saved" && <span className={s.saveStatus}>✓ saved</span>}
          {saveStatus === "error" && <span className={`${s.saveStatus} error`}>✗ save failed</span>}
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={s.section}>
      <span className={s.sectionLabel}>{label}</span>
      {children}
    </div>
  );
}

function ActionsMenu({
  ticket,
  root,
  busy,
  onAct,
  onJumpToAgent,
}: {
  ticket: Ticket;
  root: string;
  busy: boolean;
  onAct: (fn: () => Promise<unknown>, closeAfter?: boolean) => void;
  onJumpToAgent: (name: string) => void;
}) {
  const run = (args: string[], closeAfter = false) =>
    onAct(() => invoke("run_iudex", { root, args }), closeAfter);
  const spawnAndJump = (role: string) =>
    onAct(async () => {
      const s = await invoke<{ name: string }>("spawn_agent", { root, ticket: ticket.id, role });
      onJumpToAgent(s.name);
    });

  return (
    <div className={s.menu}>
      {ticket.state === "queued" && ticket.ready && (
        <button
          className={s.menuItem}
          disabled={busy}
          onClick={() => onAct(async () => {
            await invoke("run_iudex", { root, args: ["activate", ticket.id] });
            const s = await invoke<{ name: string }>("spawn_agent", { root, ticket: ticket.id, role: "impl" });
            onJumpToAgent(s.name);
          })}
        >
          Activate
        </button>
      )}
      {ticket.state === "active" && (
        <>
          <button className={s.menuItem} disabled={busy} onClick={() => run(["finish", ticket.id])}>
            Finish
          </button>
          <button className={s.menuItem} disabled={busy} onClick={() => spawnAndJump("impl")}>
            Spawn agent
          </button>
        </>
      )}
      {ticket.state === "pending-qa" && (
        <button className={s.menuItem} disabled={busy} onClick={() => spawnAndJump("qa")}>
          QA agent
        </button>
      )}
      {ticket.state === "failed" && (
        <button className={s.menuItem} disabled={busy} onClick={() => run(["retry", ticket.id])}>
          Retry
        </button>
      )}
      <button
        className={`${s.menuItem} ${s.danger}`}
        disabled={busy}
        onClick={() => run(["remove", ticket.id], true)}
      >
        Remove
      </button>
    </div>
  );
}
