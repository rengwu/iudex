import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session, Ticket, Workspace } from "../types";
import { IDEA_SKILLS } from "../lib/skills";

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
}: {
  ws: Workspace;
  root: string;
  onOpenInTerminal: (session: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null); // ticket id mid-action
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [ideating, setIdeating] = useState(false);

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
      await invoke("spawn_agent", { root, ticket: id, role: "impl" });
    });
  const finish = (id: string) =>
    act(id, () => invoke("run_iudex", { root, args: ["finish", id] }));
  const spawnImpl = (id: string) =>
    act(id, () => invoke("spawn_agent", { root, ticket: id, role: "impl" }));
  const spawnQa = (id: string) =>
    act(id, () => invoke("spawn_agent", { root, ticket: id, role: "qa" }));
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
    <div>
      <div className="tickets-toolbar">
        <button onClick={() => setComposing(true)}>New ticket</button>
        <button className="ghost" onClick={() => setIdeating(true)}>
          New idea
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <table className="tickets">
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
              <td colSpan={5} className="empty">
                no tickets yet
              </td>
            </tr>
          )}
          {ws.tickets.map((t) => (
            <tr key={t.id}>
              <td className="id">{t.id}</td>
              <td>
                <span className={`state state-${t.state}`}>{t.state}</span>
              </td>
              <td className="num">{t.qaRejects || ""}</td>
              <td className="muted">{detail(t)}</td>
              <td className="actions">
                {busy === t.id ? <span className="muted">…</span> : actionsFor(t)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

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

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
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
    <Modal title={`New ticket${nextId ? ` (${nextId})` : ""}`} onClose={onClose}>
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
          <div className="dep-grid">
            {eligible.map((t) => (
              <label key={t.id} className="dep-chip">
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
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button disabled={busy} onClick={create}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
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
    <Modal title="New idea — shape into tickets" onClose={onClose}>
      <label className="field">
        <span>Skill</span>
        <select value={skill} onChange={(e) => setSkill(e.target.value)}>
          {IDEA_SKILLS.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {chosen && <p className="modal-hint">{chosen.description}</p>}
      <label className="field">
        <span>Idea / focus (optional)</span>
        <textarea
          rows={5}
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          placeholder="describe the raw idea or area to focus on…"
        />
      </label>
      <p className="modal-hint">
        Launches an agent at the workspace root preloaded with this skill and
        opens it in the Terminal. It drives the chain to <code>iudex queue</code>;
        new tickets appear here on their own.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="modal-actions">
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button disabled={busy} onClick={launch}>
          {busy ? "Launching…" : "Launch"}
        </button>
      </div>
    </Modal>
  );
}
