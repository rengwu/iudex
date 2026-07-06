import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { Ticket, Workspace } from "../types";
import { VIEWS } from "../types";
import { IDEA_SKILLS } from "../lib/skills";
import { useNav, usePendingFocus } from "../lib/nav";
import { useTicketTitles } from "../lib/agents";
import { useSessions, addSession } from "../lib/sessions";
import {
  nextAction,
  liveAgentFor,
  expectedRole,
  inFlightBlocker,
  type Intent,
} from "../lib/ticketActions";
import { stateDot } from "../lib/badges";
import Badge from "../components/Badge";
import Dot from "../components/Dot";
import Modal from "../components/Modal";
import Button from "../components/Button";
import TabSwitcher from "../components/TabSwitcher";
import TicketDetail from "../components/TicketDetail";
import TicketGraph from "./TicketGraph";
import TicketBoard from "./TicketBoard";
import s from "./Tickets.module.scss";

// The reactive tickets table, the write-path action column, and the front-of-
// funnel launchers (compose a ticket / shape an idea via a skill agent). Every
// mutation shells through `iudex`; we never re-read after one — the events.jsonl
// doorbell refreshes the table.
export default function Tickets({
  ws,
  root,
  sequential,
}: {
  ws: Workspace;
  root: string;
  sequential: boolean;
}) {
  const { goTo } = useNav();
  const focus = usePendingFocus("tickets");
  const [busy, setBusy] = useState<string | null>(null); // ticket id mid-action
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [ideating, setIdeating] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [mode, setMode] = useState<"board" | "table" | "graph">("board");

  // Honor a focus handed in from another view: a ticket id (e.g. the Agents
  // panel's "Go to Ticket") selects it so its detail panel opens; the
  // "compose" action (Dashboard's "Compose a single ticket") opens the
  // compose modal directly.
  useEffect(() => {
    if (!focus) return;
    if (focus.action === "compose") setComposing(true);
    else if (focus.id) setSelId(focus.id);
  }, [focus]);

  // Human titles keyed by ticket id — covers queued tickets (no worktree yet),
  // whose brief still lives in .iudex/queue/, as well as active+ worktree briefs.
  const { titles, refetch: refetchTitles } = useTicketTitles(root, ws);
  const titleOf = (t: Ticket) => titles[t.id] || "";

  // The live tmux session pool — passed to `nextAction` so the table and the
  // detail panel decide the next action from the same data (the agent-presence
  // branch is #1/#5 follow-up; the param is wired now).
  const { sessions } = useSessions(root);

  // Sequential policy gate: while a ticket is in flight, activation is blocked
  // (hard policy — the note names the blocker; the CLI can still bypass).
  const seqBlocker = sequential ? inFlightBlocker(ws.tickets) : null;

  // Legend for the QA column (a bare count is opaque) — explains what the number
  // means and how it relates to the configured reject limit.
  const qaLegend =
    ws.qaRejectLimit > 0
      ? `QA rejections — times QA bounced this ticket back (${ws.qaRejectLimit} → ticket fails)`
      : "QA rejections — times QA bounced this ticket back (unlimited)";

  // Tickets shown across all three views: the live working set. Terminal
  // tickets are hidden — removed are gone, done graduate to the archive.
  const visible = ws.tickets.filter(
    (t) => t.state !== "removed" && t.state !== "done",
  );

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

  // Spawn an agent for `id` in `role` and jump to its cockpit.
  const spawnAndJump = (id: string, role: string) =>
    act(id, async () => {
      const s = await api.spawnAgent(root, id, role);
      goTo("agents", { id: s.name });
    });

  // Run a `nextAction` intent. Mapping intent → side effect is per-view (busy is
  // tracked per row here; the panel uses its own runner) but the *choice* of
  // intent is single-sourced in `nextAction`. `note` never reaches here (it
  // renders muted text, not a button).
  const runIntent = (intent: Intent, t: Ticket) => {
    switch (intent) {
      case "activate-impl":
        return act(t.id, async () => {
          await api.runIudex(root, ["activate", t.id]);
          const s = await api.spawnAgent(root, t.id, "impl");
          goTo("agents", { id: s.name });
        });
      case "resume-impl":
        return spawnAndJump(t.id, "impl");
      case "spawn-qa":
        return spawnAndJump(t.id, "qa");
      case "open-agent": {
        const sess = liveAgentFor(t, sessions);
        if (sess) return goTo("agents", { id: sess.name });
        // The agent vanished between render and click — fall back to spawning
        // the role so the button still does something useful.
        return spawnAndJump(t.id, expectedRole(t.state) ?? "impl");
      }
      case "review":
        return goTo("review", { id: t.id });
      case "retry":
        return act(t.id, () => api.runIudex(root, ["retry", t.id]));
      case "note":
        return;
    }
  };

  const depText = (t: Ticket) =>
    t.state === "queued" && !t.ready
      ? t.blockedBy.join(", ") || "—"
      : t.deps.join(", ") || "—";

  return (
    <div className={s.root}>
      <header className={s.header}>
        <Dot color={VIEWS.tickets.dot} size={8} />
        <span className={s.headerTitle}>Tickets</span>
        <TabSwitcher
          tabs={[
            { label: "Board", value: "board" },
            { label: "Table", value: "table" },
            { label: "Graph", value: "graph" },
          ]}
          value={mode}
          onChange={setMode}
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
            <TicketGraph
              tickets={visible}
              titles={titles}
              selId={selId}
              onSelect={setSelId}
            />
          ) : mode === "board" ? (
            <TicketBoard
              tickets={visible}
              titles={titles}
              sessions={sessions}
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
                <div className={s.thCenter} title={qaLegend}>
                  QA
                </div>
                <div>WORKTREE</div>
                <div>ACTION</div>
              </div>
              {visible.length === 0 && (
                <div className={s.empty}>No tickets in the pipeline</div>
              )}
              {visible.map((t, i) => {
                const a = nextAction(t, sessions, seqBlocker);
                const on = t.id === selId;
                return (
                  <div
                    key={t.id}
                    className={s.row}
                    onClick={() => setSelId(on ? null : t.id)}
                    style={{
                      background: on
                        ? "#1f2e90"
                        : i % 2
                          ? "#969696"
                          : "#9c9c9c",
                      color: on ? "#fff" : undefined,
                    }}
                  >
                    <div className={s.rowDot}>
                      <Dot color={stateDot(t.state)} />
                    </div>
                    <div
                      className={s.cellId}
                      style={on ? { color: "#fff" } : undefined}
                    >
                      {t.id}
                    </div>
                    <div
                      className={s.cellTitle}
                      style={on ? { color: "#fff" } : undefined}
                    >
                      {titleOf(t)}
                    </div>
                    <div>
                      <Badge kind="state" value={t.state} />
                    </div>
                    <div
                      className={s.cellDeps}
                      style={on ? { color: "#cdd2ff" } : undefined}
                    >
                      {depText(t)}
                    </div>
                    <div
                      className={`${s.cellQa} ${t.qaRejects > 0 ? s.cellQaHot : ""}`}
                      style={on ? { color: "#fff" } : undefined}
                      title={qaLegend}
                    >
                      {t.qaRejects || ""}
                    </div>
                    <div
                      className={s.cellWt}
                      style={on ? { color: "#cdd2ff" } : undefined}
                    >
                      {t.worktree || "—"}
                    </div>
                    <div
                      className={s.cellAct}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {busy === t.id ? (
                        <span className="muted">…</span>
                      ) : a.variant ? (
                        <Button
                          variant={a.variant}
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => runIntent(a.intent, t)}
                        >
                          {a.label}
                        </Button>
                      ) : a.label ? (
                        <span className={s.actNote}>{a.label}</span>
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
              seqBlocker={seqBlocker}
              onClose={() => setSelId(null)}
              onSaved={refetchTitles}
            />
          </div>
        )}
      </div>

      {composing && (
        <ComposeTicketModal
          ws={ws}
          root={root}
          titles={titles}
          onClose={() => setComposing(false)}
        />
      )}
      {ideating && (
        <NewIdeaModal
          root={root}
          onClose={() => setIdeating(false)}
          onLaunched={(name) => {
            setIdeating(false);
            goTo("agents", { id: name });
          }}
        />
      )}
    </div>
  );
}

function ComposeTicketModal({
  ws,
  root,
  titles,
  onClose,
}: {
  ws: Workspace;
  root: string;
  titles: Record<string, string>;
  onClose: () => void;
}) {
  const [nextId, setNextId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [deps, setDeps] = useState<string[]>([]);
  const [depQuery, setDepQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Show the id that will be allocated (it's actually claimed at Create time).
  useEffect(() => {
    api
      .runIudex(root, ["next-ticket-id"])
      .then((n) => setNextId(`t${n.trim()}`))
      .catch(() => {});
  }, [root]);

  // A ticket can only depend on a registered, live ticket — exclude failed and
  // the archived ones (removed + done) so the picker isn't cluttered with
  // tickets that are gone or already merged.
  const eligible = ws.tickets.filter(
    (t) => t.state !== "removed" && t.state !== "failed" && t.state !== "done",
  );
  const toggleDep = (id: string) =>
    setDeps((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));

  // The filtered slice of the picker list — matches id or title. Selections
  // live in `deps` regardless, so filtering never drops one.
  const q = depQuery.trim().toLowerCase();
  const shown = q
    ? eligible.filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          (titles[t.id] ?? "").toLowerCase().includes(q),
      )
    : eligible;

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
      title={`New ticket${nextId ? ` — will be ${nextId}` : ""}`}
      onClose={onClose}
      actions={
        <>
          <Button variant="quiet" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="md" disabled={busy} onClick={create}>
            {busy ? "Creating…" : "Create"}
          </Button>
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
          {deps.length > 0 && (
            <div className={s.depSelected}>
              {deps.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={s.depTag}
                  title="remove dependency"
                  onClick={() => toggleDep(id)}
                >
                  {id} ×
                </button>
              ))}
            </div>
          )}
          <input
            value={depQuery}
            onChange={(e) => setDepQuery(e.target.value)}
            placeholder="filter by id or title…"
            spellCheck={false}
          />
          <div className={s.depList}>
            {shown.map((t) => (
              <label key={t.id} className={s.depRow}>
                <input
                  type="checkbox"
                  checked={deps.includes(t.id)}
                  onChange={() => toggleDep(t.id)}
                />
                {t.id}
                {titles[t.id] && (
                  <span className={s.depTitle}>{titles[t.id]}</span>
                )}
                <span className={`muted ${s.depState}`}>{t.state}</span>
              </label>
            ))}
            {shown.length === 0 && (
              <div className={s.depEmpty}>no tickets match “{depQuery}”</div>
            )}
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
      addSession(s); // seed the pool so Agents can focus it before the next poll
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
          <Button variant="quiet" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="md" disabled={busy} onClick={launch}>
            {busy ? "Launching…" : "Launch"}
          </Button>
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
        opens it in the Agents view. It drives the chain to{" "}
        <code>iudex queue</code>; new tickets appear here on their own.
      </p>
      {error && <div className="error">{error}</div>}
    </Modal>
  );
}
