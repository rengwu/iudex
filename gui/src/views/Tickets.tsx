import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session, Ticket, Workspace } from "../types";
import { IDEA_SKILLS } from "../lib/skills";
import StateBadge from "../components/StateBadge";
import Modal from "../components/Modal";
import TicketDetail from "../components/TicketDetail";
import s from "./Tickets.module.scss";

// What to show in the trailing "detail" column for a ticket.
function detail(t: Ticket): string {
  if (t.state === "queued") {
    return t.ready ? "ready" : `blocked by ${t.blockedBy.join(", ")}`;
  }
  if (t.hasWorktree && t.worktree) return t.worktree;
  return "";
}

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

  const sel = selId ? (ws.tickets.find((t) => t.id === selId) ?? null) : null;
  // Drop selection if the ticket disappears (e.g. removed).
  if (selId && !sel) setSelId(null);

  const act = async (id: string, fn: () => Promise<void>) => {
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
      await invoke("run_iudex", { root, args: ["activate", id] });
      const s = await invoke<Session>("spawn_agent", { root, ticket: id, role: "impl" });
      onJumpToAgent(s.name);
    });
  const finish = (id: string) =>
    act(id, () => invoke("run_iudex", { root, args: ["finish", id] }));
  const spawnImpl = (id: string) =>
    act(id, async () => {
      const s = await invoke<Session>("spawn_agent", { root, ticket: id, role: "impl" });
      onJumpToAgent(s.name);
    });
  const spawnQa = (id: string) =>
    act(id, async () => {
      const s = await invoke<Session>("spawn_agent", { root, ticket: id, role: "qa" });
      onJumpToAgent(s.name);
    });
  const retry = (id: string) =>
    act(id, () => invoke("run_iudex", { root, args: ["retry", id] }));

  const actionsFor = (t: Ticket) => {
    const disabled = busy !== null;
    switch (t.state) {
      case "queued":
        return t.ready ? (
          <button disabled={disabled} onClick={() => activate(t.id)}>
            Activate
          </button>
        ) : null;
      case "active":
        return (
          <>
            <button disabled={disabled} onClick={() => finish(t.id)}>
              Finish
            </button>
            <button
              className="ghost"
              disabled={disabled}
              onClick={() => spawnImpl(t.id)}
              title="launch another impl agent"
            >
              Agent
            </button>
          </>
        );
      case "pending-qa":
        return (
          <button
            disabled={disabled}
            onClick={() => spawnQa(t.id)}
            title="launch a QA agent"
          >
            QA agent
          </button>
        );
      case "failed":
        return (
          <button disabled={disabled} onClick={() => retry(t.id)}>
            Retry
          </button>
        );
      default:
        return null;
    }
  };

  return (
    <div className={s.root}>
      <div className={s.listPane}>
        <div className={s.toolbar}>
          <button onClick={() => setComposing(true)}>New ticket</button>
          <button className="ghost" onClick={() => setIdeating(true)}>
            New idea
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        <table className={s.table}>
          <thead>
            <tr>
              <th>id</th>
              <th>state</th>
              <th>qa rejects</th>
              <th>detail</th>
              <th>actions</th>
            </tr>
          </thead>
          <tbody>
            {ws.tickets.length === 0 && (
              <tr>
                <td colSpan={5} className={s.empty}>
                  no tickets yet
                </td>
              </tr>
            )}
            {ws.tickets.map((t) => (
              <tr
                key={t.id}
                className={t.id === selId ? s.selRow : ""}
                onClick={() => setSelId(t.id === selId ? null : t.id)}
                style={{ cursor: "pointer" }}
              >
                <td className={s.id}>{t.id}</td>
                <td>
                  <StateBadge state={t.state} />
                </td>
                <td className={s.num}>{t.qaRejects || ""}</td>
                <td className={s.muted}>{detail(t)}</td>
                <td className={s.actions} onClick={(e) => e.stopPropagation()}>
                  {busy === t.id ? <span className="muted">…</span> : actionsFor(t)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
    invoke<string>("run_iudex", { root, args: ["next-ticket-id"] })
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
      await invoke("compose_ticket", { root, title, body, deps });
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
      const s = await invoke<Session>("spawn_idea", { root, skill, seed });
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
