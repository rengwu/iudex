import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Ticket, Workspace } from "../types";
import { IDEA_SKILLS } from "../lib/skills";
import { useBriefTitles } from "../lib/agents";
import { stateDot } from "../lib/badges";
import Badge from "../components/Badge";
import Modal from "../components/Modal";
import Button from "../components/Button";
import TabSwitcher from "../components/TabSwitcher";
import TicketDetail from "../components/TicketDetail";
import TicketGraph from "./TicketGraph";
import TicketBoard from "./TicketBoard";
import s from "./Tickets.module.scss";

// The row action button style per variant (ported from iudex.dc.html ACT map).
const ACT: Record<string, { bg: string; color: string; border: string }> = {
  primary: { bg: "#f4bc41", color: "#2a2a2a", border: "1px solid #c79320" },
  normal: { bg: "#9c9c9c", color: "#2a2a2a", border: "1px solid #8a8a8a" },
  ghost: { bg: "#9c9c9c", color: "#2a2a2a", border: "1px solid #6f6f6f" },
  danger: { bg: "#e0584c", color: "#ffffff", border: "1px solid #b03d33" },
  disabled: { bg: "transparent", color: "#565656", border: "1px solid transparent" },
};

// The reactive tickets table, the write-path action column, and the front-of-
// funnel launchers (compose a ticket / shape an idea via a skill agent). Every
// mutation shells through `iudex`; we never re-read after one — the events.jsonl
// doorbell refreshes the table.
export default function Tickets({
  ws,
  root,
  onOpenInTerminal,
  onJumpToAgent,
}: {
  ws: Workspace;
  root: string;
  onOpenInTerminal: (session: string) => void;
  onJumpToAgent: (sessionName: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null); // ticket id mid-action
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [ideating, setIdeating] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [mode, setMode] = useState<"board" | "table" | "graph">("board");

  // Human titles for tickets that have a worktree (briefs live in the worktree).
  const titles = useBriefTitles(
    ws.tickets.flatMap((t) => (t.worktree ? [t.worktree] : [])),
    ws,
  );
  const titleOf = (t: Ticket) => (t.worktree && titles[t.worktree]) || "";

  // Tickets shown across all three views: the live working set. Terminal
  // tickets are hidden — removed are gone, done graduate to the archive.
  const visible = ws.tickets.filter((t) => t.state !== "removed" && t.state !== "done");

  const sel = selId ? (ws.tickets.find((t) => t.id === selId) ?? null) : null;
  // Drop selection if the ticket disappears (e.g. removed).
  if (selId && !sel) setSelId(null);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(`${id}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const activate = (id: string) =>
    act(id, async () => {
      await api.runIudex(root, ["activate", id]);
      const s = await api.spawnAgent(root, id, "impl");
      onJumpToAgent(s.name);
    });
  const finish = (id: string) =>
    act(id, () => api.runIudex(root, ["finish", id]));
  const spawnQa = (id: string) =>
    act(id, async () => {
      const s = await api.spawnAgent(root, id, "qa");
      onJumpToAgent(s.name);
    });
  const retry = (id: string) =>
    act(id, () => api.runIudex(root, ["retry", id]));

  // The single row action per state (secondary actions live in the detail menu).
  const rowAction = (
    t: Ticket,
  ): { label: string; variant: keyof typeof ACT; onClick?: () => void } => {
    switch (t.state) {
      case "queued":
        return t.ready
          ? { label: "Activate", variant: "primary", onClick: () => activate(t.id) }
          : { label: "blocked", variant: "disabled" };
      case "active":
        return { label: "Finish", variant: "normal", onClick: () => finish(t.id) };
      case "pending-qa":
        return { label: "Spawn QA", variant: "ghost", onClick: () => spawnQa(t.id) };
      case "failed":
        return { label: "Retry", variant: "danger", onClick: () => retry(t.id) };
      case "done":
        return { label: "✓ merged", variant: "disabled" };
      default:
        return { label: "", variant: "disabled" };
    }
  };

  const depText = (t: Ticket) =>
    t.state === "queued" && !t.ready ? t.blockedBy.join(", ") || "—" : t.deps.join(", ") || "—";

  return (
    <div className={s.root}>
      <header className={s.header}>
        <span className={s.headerDot} />
        <span className={s.headerTitle}>Tickets</span>
        <TabSwitcher
          tabs={["Board", "Table", "Graph"]}
          value={mode[0].toUpperCase() + mode.slice(1)}
          onChange={(v) => setMode(v.toLowerCase() as typeof mode)}
          style={{ marginLeft: 4 }}
        />
        <span className={s.headerSpacer} />
        <Button variant="primary" size="sm" onClick={() => setComposing(true)}>
          + Compose Ticket
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setIdeating(true)}>
          Shape Idea
        </Button>
      </header>

      {error && <div className="error">{error}</div>}

      <div className={s.bodyRow}>
        <div className={s.listPane}>
          {mode === "graph" ? (
            <TicketGraph tickets={visible} titles={titles} selId={selId} onSelect={setSelId} />
          ) : mode === "board" ? (
            <TicketBoard
              tickets={visible}
              titles={titles}
              maxActive={ws.maxActive}
              selId={selId}
              onSelect={setSelId}
            />
          ) : (
            <>
              <div className={s.thead}>
                <div />
                <div>ID</div>
                <div>TITLE</div>
                <div>STATE</div>
                <div>DEPS</div>
                <div className={s.thCenter}>QA</div>
                <div>WORKTREE</div>
                <div>ACTION</div>
              </div>
              {visible.length === 0 && <div className={s.empty}>no tickets yet</div>}
              {visible.map((t, i) => {
                const a = rowAction(t);
                const on = t.id === selId;
                return (
                  <div
                    key={t.id}
                    className={s.row}
                    onClick={() => setSelId(on ? null : t.id)}
                    style={{
                      background: on ? "#1f2e90" : i % 2 ? "#969696" : "#9c9c9c",
                      color: on ? "#fff" : undefined,
                    }}
                  >
                    <div className={s.rowDot}>
                      <span className={s.dot} style={{ background: stateDot(t.state) }} />
                    </div>
                    <div className={s.cellId} style={on ? { color: "#fff" } : undefined}>
                      {t.id}
                    </div>
                    <div className={s.cellTitle} style={on ? { color: "#fff" } : undefined}>
                      {titleOf(t)}
                    </div>
                    <div>
                      <Badge kind="state" value={t.state} />
                    </div>
                    <div className={s.cellDeps} style={on ? { color: "#cdd2ff" } : undefined}>
                      {depText(t)}
                    </div>
                    <div
                      className={`${s.cellQa} ${t.qaRejects > 0 ? s.cellQaHot : ""}`}
                      style={on ? { color: "#fff" } : undefined}
                    >
                      {t.qaRejects || ""}
                    </div>
                    <div className={s.cellWt} style={on ? { color: "#cdd2ff" } : undefined}>
                      {t.worktree || "—"}
                    </div>
                    <div className={s.cellAct} onClick={(e) => e.stopPropagation()}>
                      {busy === t.id ? (
                        <span className="muted">…</span>
                      ) : a.label ? (
                        <span
                          className={s.actBtn}
                          style={{
                            ...ACT[a.variant],
                            cursor: a.onClick && busy === null ? "pointer" : "default",
                            opacity: a.onClick && busy !== null ? 0.5 : 1,
                          }}
                          onClick={() => busy === null && a.onClick?.()}
                        >
                          {a.label}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {sel && (
          <div className={s.panel}>
            <TicketDetail
              root={root}
              ticket={sel}
              ws={ws}
              onClose={() => setSelId(null)}
              onJumpToAgent={onJumpToAgent}
            />
          </div>
        )}
      </div>

      {composing && (
        <ComposeTicketModal
          ws={ws}
          root={root}
          onClose={() => setComposing(false)}
        />
      )}
      {ideating && (
        <NewIdeaModal
          root={root}
          onClose={() => setIdeating(false)}
          onLaunched={(name) => {
            setIdeating(false);
            onOpenInTerminal(name);
          }}
        />
      )}
    </div>
  );
}

function ComposeTicketModal({
  ws,
  root,
  onClose,
}: {
  ws: Workspace;
  root: string;
  onClose: () => void;
}) {
  const [nextId, setNextId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [deps, setDeps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Show the id that will be allocated (it's actually claimed at Create time).
  useEffect(() => {
    api
      .runIudex(root, ["next-ticket-id"])
      .then((n) => setNextId(`t${n.trim()}`))
      .catch(() => {});
  }, [root]);

  // A ticket can only depend on a registered, non-terminal-failure ticket.
  const eligible = ws.tickets.filter(
    (t) => t.state !== "removed" && t.state !== "failed"
  );
  const toggleDep = (id: string) =>
    setDeps((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.composeTicket(root, title, body, deps);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`New ticket${nextId ? ` (${nextId})` : ""}`}
      onClose={onClose}
      actions={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button disabled={busy} onClick={create}>
            {busy ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Title</span>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="short summary"
        />
      </label>
      <label className="field">
        <span>Brief</span>
        <textarea
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="markdown brief — what to build, acceptance, context…"
        />
      </label>
      {eligible.length > 0 && (
        <div className="field">
          <span>Depends on</span>
          <div className={s.depGrid}>
            {eligible.map((t) => (
              <label key={t.id} className={s.depChip}>
                <input
                  type="checkbox"
                  checked={deps.includes(t.id)}
                  onChange={() => toggleDep(t.id)}
                />
                {t.id} <span className="muted">{t.state}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}

function NewIdeaModal({
  root,
  onClose,
  onLaunched,
}: {
  root: string;
  onClose: () => void;
  onLaunched: (session: string) => void;
}) {
  const [skill, setSkill] = useState(IDEA_SKILLS[0].slug);
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = IDEA_SKILLS.find((s) => s.slug === skill);

  const launch = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.spawnIdea(root, skill, seed);
      onLaunched(s.name);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New idea — shape into tickets"
      onClose={onClose}
      actions={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button disabled={busy} onClick={launch}>
            {busy ? "Launching…" : "Launch"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Skill</span>
        <select value={skill} onChange={(e) => setSkill(e.target.value)}>
          {IDEA_SKILLS.map((sk) => (
            <option key={sk.slug} value={sk.slug}>
              {sk.label}
            </option>
          ))}
        </select>
      </label>
      {chosen && <p className={s.hint}>{chosen.description}</p>}
      <label className="field">
        <span>Idea / focus (optional)</span>
        <textarea
          rows={5}
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          placeholder="describe the raw idea or area to focus on…"
        />
      </label>
      <p className={s.hint}>
        Launches an agent at the workspace root preloaded with this skill and
        opens it in the Terminal. It drives the chain to <code>iudex queue</code>;
        new tickets appear here on their own.
      </p>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}
