import { Suspense, lazy, useEffect, useState } from "react";
import * as api from "../lib/api";
import type {
  FileChange,
  FileDiff,
  Preflight,
  Resolution,
  ResolutionSummary,
  Ticket,
  Workspace,
} from "../types";
import { VIEWS } from "../types";
import { useRailStatus, useReview } from "../lib/review";
import { useNav, usePendingFocus } from "../lib/nav";
import { useSessions } from "../lib/sessions";
import ChangedFilesDiff from "../components/ChangedFilesDiff";
import DiffPatch from "../components/DiffPatch";
import Modal from "../components/Modal";
import ViewHeader from "../components/ViewHeader";
import Badge from "../components/Badge";
import Button from "../components/Button";
import s from "./Review.module.scss";

const MergeEditor = lazy(() => import("./MergeEditor"));

type Tab = "brief" | "log" | "review" | "changes" | "conflicts";

const TAB_LABELS: Record<Tab, string> = {
  brief: "Ticket Brief",
  log: "Implementation Log",
  review: "Agent Review",
  changes: "Changes",
  conflicts: "Conflicts",
};

// The deep-review workspace for pending-human-qa tickets. The rail is the merge
// to-do list (each card carries a title + merge badge so clean merges can be
// sequenced ahead of conflicted ones); the main pane is tabbed — read-only
// inspection (brief / implementation log / qa review / changes) plus a `conflicts` tab
// that holds the merge-readiness workspace. Approve only ever fires when the
// preflight guarantees the merge succeeds.
export default function Review({ ws, root }: { ws: Workspace; root: string }) {
  const { goTo } = useNav();
  const focusTicket = usePendingFocus("review");
  const pending = ws.tickets.filter((t) => t.state === "pending-human-qa");

  const [selId, setSelId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("brief");
  const [selFile, setSelFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const [mergeFile, setMergeFile] = useState<string | null>(null);

  const { sessions } = useSessions(root);

  // Honor a ticket handed in from another view (e.g. a panel's "Go to Review").
  useEffect(() => {
    if (focusTicket) setSelId(focusTicket.id);
  }, [focusTicket]);

  // Keep the selection valid as the pending list changes (e.g. after approve).
  useEffect(() => {
    if (pending.length === 0) {
      setSelId(null);
    } else if (!pending.some((t) => t.id === selId)) {
      setSelId(pending[0].id);
    }
  }, [pending, selId]);

  const selected: Ticket | null = pending.find((t) => t.id === selId) ?? null;
  const worktree = selected?.worktree ?? null;
  const { docs, changes, preflight, resolution, error, recheck } = useReview(
    root,
    worktree,
    ws,
  );
  const rail = useRailStatus(
    root,
    ws.mainBranch,
    pending.flatMap((t) => (t.worktree ? [t.worktree] : [])),
    ws,
    `${preflight?.ready}-${preflight?.mergeInProgress}`,
  );
  const title = (worktree && rail[worktree]?.title) || "";

  // A live conflict-resolution agent for this ticket, if one is running.
  const resolver =
    sessions.find(
      (s) => s.kind === "agent" && s.ticket === selId && s.role === "resolve",
    ) ?? null;

  // Reset the open file / tab / merge editor when switching tickets.
  useEffect(() => {
    setSelFile(null);
    setDiff(null);
    setActErr(null);
    setMergeFile(null);
  }, [selId]);

  // Default-select the first changed file so the Changes tab opens on a diff.
  useEffect(() => {
    setSelFile((prev) =>
      changes.some((c) => c.path === prev) ? prev : (changes[0]?.path ?? null),
    );
  }, [changes]);

  // A worktree merge doesn't touch events.jsonl, so there's no doorbell while an
  // agent (or the user) resolves — poll the git state to keep the tab live.
  useEffect(() => {
    if (!preflight?.mergeInProgress) return;
    const h = setInterval(() => recheck(), 3000);
    return () => clearInterval(h);
  }, [preflight?.mergeInProgress, recheck]);

  // Load the three-dot diff for the selected file.
  useEffect(() => {
    if (!worktree || !selFile) {
      setDiff(null);
      return;
    }
    let alive = true;
    api
      .worktreeFileDiff(worktree, selFile, ws.mainBranch, true)
      .then((d) => alive && setDiff(d))
      .catch((e) => alive && setActErr(String(e)));
    return () => {
      alive = false;
    };
  }, [worktree, selFile, ws.mainBranch]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActErr(null);
    try {
      await fn();
    } catch (e) {
      setActErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const approve = () =>
    act(async () => {
      if (!selId) return;
      try {
        await api.runIudex(root, ["human-qa", "approve", selId]);
        // The doorbell will drop this ticket out of `pending`; selection follows.
      } catch (e) {
        // The preflight predicts conflicts via `git merge-tree`, but main can move
        // between the prediction and this real merge. iudex aborts+restores on any
        // surprise conflict; re-run the preflight so the tab reflects reality, and
        // show a calm note for that expected case rather than git's raw CONFLICT
        // dump. Non-merge failures still surface verbatim.
        recheck();
        const msg = String(e);
        if (/conflict/i.test(msg) || /merge .*failed/i.test(msg)) {
          setActErr(
            "main moved since the preflight — re-checking for conflicts. See the Conflicts tab.",
          );
        } else {
          setActErr(msg);
        }
      }
    });

  const reject = (reason: string) =>
    act(async () => {
      if (!selId) return;
      // A reject sends the ticket back to active — where an impl agent (auto-
      // respawned or human-launched) will work in this worktree. A resolution
      // merge left in progress (MERGE_HEAD + conflict markers) would poison
      // that, so abort it first; a rejected ticket is being re-implemented
      // anyway, which makes the stale resolution worthless.
      if (worktree) {
        const res = await api.readResolution(worktree).catch(() => null);
        if (res?.mergeInProgress) await api.abortResolution(worktree);
      }
      await api.runIudex(root, [
        "human-qa",
        "reject",
        selId,
        "--reason",
        reason,
      ]);
    });

  const beginResolution = () =>
    act(async () => {
      if (!worktree) return;
      await api.beginResolution(worktree, ws.mainBranch);
      recheck();
    });
  const abortResolution = () =>
    act(async () => {
      if (!worktree) return;
      await api.abortResolution(worktree);
      setMergeFile(null);
      recheck();
    });
  // Merge main into the worktree, then hand the conflicts to a triage agent. If
  // the merge happens to be clean (no conflicts) we skip the agent entirely.
  // Unlike other spawns, this intentionally stays in Review (the nav rule's one
  // exception, see lib/nav.ts): the Conflicts tab is the resolver's cockpit, and
  // "Watch" jumps to its console on demand.
  const resolveWithAgent = () =>
    act(async () => {
      if (!worktree || !selId) return;
      const conflicts = await api.beginResolution(worktree, ws.mainBranch);
      if (conflicts) {
        await api.spawnResolver(root, selId, worktree);
      }
      recheck();
    });
  const stopResolver = () =>
    act(async () => {
      if (resolver) await api.killSession(resolver.name);
    });
  const commitResolution = () =>
    act(async () => {
      if (!worktree) return;
      await api.commitResolution(worktree);
      setMergeFile(null);
      recheck();
    });
  // Watch = jump to the Agents cockpit and open the resolver's console tab,
  // rather than spawning a separate Terminal tab for it.
  const watchResolver = () => {
    if (resolver) goTo("agents", { id: resolver.name, tab: "console" });
  };
  const openShell = (cwd: string) =>
    act(async () => {
      const s = await api.createShell(root, cwd);
      goTo("terminal", { id: s.name });
    });
  const openInEditor = (path: string) =>
    api.openInEditor(path).catch((e) => setActErr(String(e)));
  const revealInFinder = (path: string) =>
    api.revealInFinder(path).catch((e) => setActErr(String(e)));
  const openFolderWith = (path: string) =>
    api.openFolderWith(path).catch((e) => setActErr(String(e)));

  // Jump from a conflicting filename straight to its diff under the Changes tab.
  const pickConflict = (f: string) => {
    setSelFile(f);
    setTab("changes");
  };

  if (pending.length === 0)
    return (
      <div className={s.view}>
        <ViewHeader dot={VIEWS.review.dot} title="Review" />
        <div className={s.empty}>Nothing awaiting human review.</div>
      </div>
    );

  const docText =
    tab === "brief" ? docs?.brief : tab === "log" ? docs?.log : docs?.review;
  const conflictsFlagged = !!preflight && !preflight.ready;
  const hb = headerBadge(preflight);

  return (
    <div className={s.view}>
      <ViewHeader dot={VIEWS.review.dot} title="Review" />
      <div className={s.root}>
        <aside className={s.rail}>
          <div className={s.railHead}>PENDING HUMAN QA</div>
          {pending.map((t) => {
            const b = railBadge(
              t.worktree ? rail[t.worktree]?.badge : undefined,
            );
            return (
              <button
                key={t.id}
                className={`${s.item} ${t.id === selId ? s.active : ""}`}
                onClick={() => setSelId(t.id)}
              >
                <span className={s.itemTop}>
                  <span className={s.itemId}>{t.id}</span>
                  <span className={s.itemTitle}>
                    {(t.worktree && rail[t.worktree]?.title) || "…"}
                  </span>
                </span>
                <span className={s.itemSub}>qa&nbsp;✓</span>
                <Badge kind="merge" value={b.cls}>
                  {b.label}
                </Badge>
              </button>
            );
          })}
        </aside>

        <div className={s.main}>
          <header className={s.head}>
            <div className={s.headInfo}>
              <div className={s.headTitle}>
                <span className={s.headId}>{selId}</span>
                <span className={s.headName}>{title}</span>
              </div>
              <div className={s.headSub}>
                <span className={s.headVerdict}>qa&nbsp;✓ approved</span>
                <span className={s.dot}>·</span>
                <Badge kind="merge" value={hb.cls}>
                  {hb.label}
                </Badge>
              </div>
            </div>
            {worktree && (
              <div className={s.headActions}>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => revealInFinder(worktree)}
                >
                  Reveal in Finder
                </Button>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => openFolderWith(worktree)}
                >
                  Open with…
                </Button>
              </div>
            )}
          </header>

          {error && <div className="error">{error}</div>}

          <nav className={s.doctabs}>
            {(["brief", "log", "review", "changes", "conflicts"] as Tab[]).map(
              (d) => (
                <button
                  key={d}
                  className={`${s.doctab} ${tab === d ? s.active : ""}`}
                  onClick={() => setTab(d)}
                >
                  {d === "changes"
                    ? `Changes (${changes.length})`
                    : TAB_LABELS[d]}
                  {d === "conflicts" && conflictsFlagged && (
                    <span className={s.tabDot} />
                  )}
                </button>
              ),
            )}
          </nav>

          <div className={s.content}>
            {tab === "changes" ? (
              <ChangedFilesDiff
                changes={changes}
                selected={selFile}
                onSelect={setSelFile}
                diff={diff}
                noChangesHint="no changes vs merge-base"
                fileActions={
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() =>
                      worktree &&
                      selFile &&
                      openInEditor(`${worktree}/${selFile}`)
                    }
                  >
                    Open in editor
                  </Button>
                }
              />
            ) : tab === "conflicts" ? (
              mergeFile && worktree ? (
                <Suspense
                  fallback={<div className="muted">loading editor…</div>}
                >
                  <MergeEditor
                    worktree={worktree}
                    path={mergeFile}
                    busy={busy}
                    onResolved={() => {
                      setMergeFile(null);
                      recheck();
                    }}
                    onCancel={() => setMergeFile(null)}
                  />
                </Suspense>
              ) : (
                <ConflictsTab
                  pf={preflight}
                  resolution={resolution}
                  resolverActive={!!resolver}
                  worktree={worktree}
                  mainBranch={ws.mainBranch}
                  busy={busy}
                  onResolveAgent={resolveWithAgent}
                  onWatch={watchResolver}
                  onStop={stopResolver}
                  onCommit={commitResolution}
                  onShellRoot={() => openShell(root)}
                  onShellWorktree={() => worktree && openShell(worktree)}
                  onBegin={beginResolution}
                  onAbort={abortResolution}
                  onRecheck={recheck}
                  onPickConflict={pickConflict}
                  onOpenFlagged={(f) => setMergeFile(f)}
                />
              )
            ) : (
              <div className={s.docSection}>
                <div className={s.docHead}>
                  <span className={s.docLabel}>{TAB_LABELS[tab]}</span>
                  {selId && (
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={() => goTo("tickets", { id: selId })}
                    >
                      Go to Ticket
                    </Button>
                  )}
                </div>
                <pre className={s.doc}>
                  {docText?.trim() ? docText : `(no ${TAB_LABELS[tab]})`}
                </pre>
              </div>
            )}
          </div>

          {actErr && <div className="error">{actErr}</div>}

          <div className={s.actions}>
            <RejectButton disabled={busy} onReject={reject} />
            <button
              className={s.approve}
              disabled={busy || !preflight?.ready}
              title={
                preflight?.ready
                  ? "merge into main"
                  : "blocked — see the Conflicts tab"
              }
              onClick={approve}
            >
              {busy ? "…" : "Approve & merge"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// The merge-readiness workspace (the Conflicts tab). It walks the resolution
// through its phases: ready → root-gate → predicted-conflict (Resolve with agent
// / manually) → resolving (agent triaging) → flagged (open the merge editor) →
// all-resolved (commit). A flagged conflict keeps Approve blocked until cleared.
// The Conflicts tab in the ready state. Two parts: (1) a resolution breakdown —
// the lines a committed conflict resolution kept/removed (from `resolution_summary`,
// rendered as a patch) — or, for a genuinely clean merge, a one-line summary; and
// (2) the full merge preview below: the net effect on main (two-dot changes) via
// the shared ChangedFilesDiff.
function ReadySummary({
  worktree,
  mainBranch,
}: {
  worktree: string | null;
  mainBranch: string;
}) {
  const [summary, setSummary] = useState<ResolutionSummary | null>(null);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [selFile, setSelFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!worktree) return;
    let alive = true;
    setSelFile(null);
    setDiff(null);
    Promise.all([
      api.resolutionSummary(worktree, mainBranch),
      // Net effect on main (two-dot) = what Approve lands; distinct from the
      // Changes tab's three-dot (the ticket's authored changes).
      api.worktreeChanges(worktree, mainBranch, false),
    ])
      .then(([rs, ch]) => {
        if (!alive) return;
        setSummary(rs);
        setChanges(ch);
        setErr(null);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, [worktree, mainBranch]);

  useEffect(() => {
    if (!worktree || !selFile) {
      setDiff(null);
      return;
    }
    let alive = true;
    api
      .worktreeFileDiff(worktree, selFile, mainBranch, false)
      .then((d) => alive && setDiff(d))
      .catch(() => alive && setDiff(null));
    return () => {
      alive = false;
    };
  }, [worktree, selFile, mainBranch]);

  const n = changes.length;
  return (
    <div className={s.readyWrap}>
      <div className={s.readyText}>
        {err && <div className="error">{err}</div>}
        {summary?.resolved ? (
          <p className={s.ready}>
            ✓ Conflicts resolved — kept (+) and removed (−) below.
          </p>
        ) : (
          <p className={s.ready}>✓ No predicted conflicts.</p>
        )}
        {summary && !summary.resolved && (
          <p className="muted">
            No predicted conflicts — {n} file{n === 1 ? "" : "s"} would change on{" "}
            {mainBranch}. (Predicted via git merge-tree; main can still move.)
          </p>
        )}
      </div>
      {summary?.resolved && (
        <div className={s.resPatch}>
          <DiffPatch text={summary.patch} />
        </div>
      )}
      <div className={s.previewHead}>
        Merge preview · what Approve lands on {mainBranch}
      </div>
      <div className={s.previewWrap}>
        <ChangedFilesDiff
          changes={changes}
          selected={selFile}
          onSelect={setSelFile}
          diff={diff}
          noChangesHint="no changes vs main"
        />
      </div>
    </div>
  );
}

function ConflictsTab({
  pf,
  resolution,
  resolverActive,
  worktree,
  mainBranch,
  busy,
  onResolveAgent,
  onWatch,
  onStop,
  onCommit,
  onShellRoot,
  onShellWorktree,
  onBegin,
  onAbort,
  onRecheck,
  onPickConflict,
  onOpenFlagged,
}: {
  pf: Preflight | null;
  resolution: Resolution | null;
  resolverActive: boolean;
  worktree: string | null;
  mainBranch: string;
  busy: boolean;
  onResolveAgent: () => void;
  onWatch: () => void;
  onStop: () => void;
  onCommit: () => void;
  onShellRoot: () => void;
  onShellWorktree: () => void;
  onBegin: () => void;
  onAbort: () => void;
  onRecheck: () => void;
  onPickConflict: (f: string) => void;
  onOpenFlagged: (f: string) => void;
}) {
  if (!pf)
    return (
      <div className={`${s.confPad} muted`}>Checking merge readiness…</div>
    );
  if (pf.ready)
    return <ReadySummary worktree={worktree} mainBranch={mainBranch} />;

  // Root-level gates apply regardless of conflicts.
  if (!pf.onMain)
    return (
      <div className={`${s.confPad} ${s.blocked}`}>
        <div className={s.gate}>
          <span className={s.gateMsg}>
            ⚠ Repo root is on <b>{pf.currentBranch}</b>, not the main branch —
            switch it first.
          </span>
        </div>
      </div>
    );
  if (!pf.clean)
    return (
      <div className={`${s.confPad} ${s.blocked}`}>
        <div className={s.gate}>
          <span className={s.gateMsg}>
            ⚠ Repo root has {pf.dirtyFiles.length} uncommitted change
            {pf.dirtyFiles.length === 1 ? "" : "s"} — commit or stash first.
          </span>
          <Button
            variant="quiet"
            size="sm"
            disabled={busy}
            onClick={onShellRoot}
          >
            Open shell at root
          </Button>
        </div>
      </div>
    );

  // A merge is underway in the worktree (agent or manual).
  if (pf.mergeInProgress) {
    const flagged = resolution?.flagged ?? [];
    const allResolved = flagged.length === 0;
    const resolved = resolution?.resolved ?? [];
    return (
      <div className={`${s.confPad} ${s.blocked}`}>
        {resolverActive && (
          <div className={s.resolver}>
            <span className={s.gateMsg}>
              ◐ Resolver agent working in the worktree…
            </span>
            <Button variant="quiet" size="sm" disabled={busy} onClick={onWatch}>
              Watch
            </Button>
            <Button variant="danger" size="sm" disabled={busy} onClick={onStop}>
              Stop
            </Button>
            <Button
              variant="quiet"
              size="sm"
              disabled={busy}
              onClick={onRecheck}
            >
              Re-check
            </Button>
          </div>
        )}

        {allResolved ? (
          <div className={s.gate}>
            <span className={s.gateMsg}>
              ✓ All conflicts resolved — commit to finish the merge.
            </span>
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={onCommit}
            >
              Commit resolution
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={onAbort}
            >
              Abort
            </Button>
          </div>
        ) : (
          <>
            <p className={s.flagHead}>
              {resolution?.hasReport
                ? `Agent flagged ${flagged.length} conflict${
                    flagged.length === 1 ? "" : "s"
                  } for your judgment — open one to resolve it:`
                : `${flagged.length} unresolved conflict${
                    flagged.length === 1 ? "" : "s"
                  } — open one to resolve it:`}
            </p>
            <ul className={s.flaglist}>
              {flagged.map((f) => (
                <li key={f.file}>
                  <button
                    className={s.flagOpen}
                    onClick={() => onOpenFlagged(f.file)}
                  >
                    <span className={s.flagFile}>{f.file}</span>
                    {f.reason && (
                      <span className={s.flagReason}>{f.reason}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {resolved.length > 0 && (
              <p className={`muted ${s.resolvedNote}`}>
                Agent already resolved: {resolved.map((r) => r.file).join(", ")}
              </p>
            )}
            <div className={s.gateActions}>
              <Button
                variant="quiet"
                size="sm"
                disabled={busy}
                onClick={onShellWorktree}
              >
                Open worktree shell
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={onAbort}
              >
                Abort resolution
              </Button>
              <Button
                variant="quiet"
                size="sm"
                disabled={busy}
                onClick={onRecheck}
              >
                Re-check
              </Button>
            </div>
          </>
        )}
      </div>
    );
  }

  // Predicted conflict, not yet started.
  return (
    <div className={`${s.confPad} ${s.blocked}`}>
      <div className={s.gate}>
        <span className={s.gateMsg}>
          ⚠ Would conflict in {pf.conflictFiles.length} file
          {pf.conflictFiles.length === 1 ? "" : "s"}:
        </span>
        <span className={s.conflicts}>
          {pf.conflictFiles.map((f) => (
            <button
              key={f}
              className={s.conflict}
              onClick={() => onPickConflict(f)}
            >
              {f}
            </button>
          ))}
        </span>
      </div>
      <div className={s.gateActions}>
        <Button
          variant="info"
          size="sm"
          disabled={busy}
          onClick={onResolveAgent}
        >
          Resolve with agent
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={onBegin}>
          Resolve manually
        </Button>
        <Button
          variant="quiet"
          size="sm"
          disabled={busy}
          onClick={onShellWorktree}
        >
          Open worktree shell
        </Button>
        <Button variant="quiet" size="sm" disabled={busy} onClick={onRecheck}>
          Re-check
        </Button>
      </div>
    </div>
  );
}

// Header/rail badge helpers — both render the same vocabulary so the rail card
// and the open ticket can never disagree.
function headerBadge(pf: Preflight | null): { label: string; cls: string } {
  if (!pf) return { label: "checking…", cls: "clean" };
  if (pf.ready) return { label: "✓ ready to merge", cls: "clean" };
  if (pf.mergeInProgress) return { label: "◐ resolving", cls: "resolving" };
  if (pf.wouldConflict)
    return {
      label: `⚠ ${pf.conflictFiles.length} conflict${pf.conflictFiles.length === 1 ? "" : "s"}`,
      cls: "conflicts",
    };
  if (!pf.onMain) return { label: "⚠ root not on main", cls: "conflicts" };
  if (!pf.clean) return { label: "⚠ root dirty", cls: "conflicts" };
  return { label: "⚠ blocked", cls: "conflicts" };
}

function railBadge(badge?: string): { label: string; cls: string } {
  switch (badge) {
    case "conflicts":
      return { label: "⚠ conflicts", cls: "conflicts" };
    case "resolving":
      return { label: "◐ resolving", cls: "resolving" };
    case "clean":
      return { label: "✓ clean", cls: "clean" };
    default:
      return { label: "…", cls: "clean" };
  }
}

function RejectButton({
  disabled,
  onReject,
}: {
  disabled: boolean;
  onReject: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <>
      <button
        className={s.reject}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Reject…
      </button>
      {open && (
        <Modal
          title="Reject — back to active"
          onClose={() => setOpen(false)}
          actions={
            <>
              <Button variant="quiet" size="md" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="md"
                disabled={!reason.trim()}
                onClick={() => {
                  onReject(reason.trim());
                  setOpen(false);
                }}
              >
                Reject
              </Button>
            </>
          }
        >
          <label className="field">
            <span>Reason (appended to review.md)</span>
            <textarea
              autoFocus
              rows={5}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="what needs to change…"
            />
          </label>
        </Modal>
      )}
    </>
  );
}
