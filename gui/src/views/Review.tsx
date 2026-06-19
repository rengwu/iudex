import { Suspense, lazy, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileDiff, Preflight, Resolution, Session, Ticket, Workspace } from "../types";
import { useRailStatus, useReview } from "../lib/review";
import { useSessions } from "../lib/sessions";
import ChangedFilesDiff from "../components/ChangedFilesDiff";
import Modal from "../components/Modal";
import s from "./Review.module.scss";

const MergeEditor = lazy(() => import("./MergeEditor"));

type Tab = "brief" | "log" | "review" | "changes" | "conflicts";

const TAB_LABELS: Record<Tab, string> = {
  brief: "brief",
  log: "impl log",
  review: "qa review",
  changes: "changes",
  conflicts: "conflicts",
};

// The deep-review workspace for pending-human-qa tickets. The rail is the merge
// to-do list (each card carries a title + merge badge so clean merges can be
// sequenced ahead of conflicted ones); the main pane is tabbed — read-only
// inspection (brief / impl log / qa review / changes) plus a `conflicts` tab
// that holds the merge-readiness workspace. Approve only ever fires when the
// preflight guarantees the merge succeeds.
export default function Review({
  ws,
  root,
  focusTicket,
  onFocusHandled,
  onOpenInTerminal,
}: {
  ws: Workspace;
  root: string;
  focusTicket: string | null;
  onFocusHandled: () => void;
  onOpenInTerminal: (session: string) => void;
}) {
  const pending = ws.tickets.filter((t) => t.state === "pending-human-qa");

  const [selId, setSelId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("brief");
  const [selFile, setSelFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const [mergeFile, setMergeFile] = useState<string | null>(null);

  const { sessions } = useSessions();

  // Honor a ticket handed in from the Dashboard.
  useEffect(() => {
    if (focusTicket) {
      setSelId(focusTicket);
      onFocusHandled();
    }
  }, [focusTicket, onFocusHandled]);

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
  const { docs, changes, preflight, resolution, error, recheck } = useReview(root, worktree, ws);
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
    sessions.find((s) => s.kind === "agent" && s.ticket === selId && s.role === "resolve") ?? null;

  // Reset the open file / tab / merge editor when switching tickets.
  useEffect(() => {
    setSelFile(null);
    setDiff(null);
    setActErr(null);
    setMergeFile(null);
  }, [selId]);

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
    invoke<FileDiff>("worktree_file_diff", {
      worktree,
      path: selFile,
      mainBranch: ws.mainBranch,
      threeDot: true,
    })
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
      try {
        await invoke("run_iudex", { root, args: ["human-qa", "approve", selId] });
        // The doorbell will drop this ticket out of `pending`; selection follows.
      } catch (e) {
        // iudex aborts+restores on any surprise conflict; re-run preflight so the
        // tab reflects the real state, then surface the error.
        recheck();
        throw e;
      }
    });

  const reject = (reason: string) =>
    act(() => invoke("run_iudex", { root, args: ["human-qa", "reject", selId, "--reason", reason] }));

  const beginResolution = () =>
    act(async () => {
      await invoke("begin_resolution", { worktree, mainBranch: ws.mainBranch });
      recheck();
    });
  const abortResolution = () =>
    act(async () => {
      await invoke("abort_resolution", { worktree });
      setMergeFile(null);
      recheck();
    });
  // Merge main into the worktree, then hand the conflicts to a triage agent. If
  // the merge happens to be clean (no conflicts) we skip the agent entirely.
  const resolveWithAgent = () =>
    act(async () => {
      const conflicts = await invoke<boolean>("begin_resolution", {
        worktree,
        mainBranch: ws.mainBranch,
      });
      if (conflicts && worktree) {
        await invoke<Session>("spawn_resolver", { root, ticket: selId, worktree });
      }
      recheck();
    });
  const stopResolver = () =>
    act(async () => {
      if (resolver) await invoke("kill_session", { name: resolver.name });
    });
  const commitResolution = () =>
    act(async () => {
      await invoke("commit_resolution", { worktree });
      setMergeFile(null);
      recheck();
    });
  const watchResolver = () => {
    if (resolver) onOpenInTerminal(resolver.name);
  };
  const openShell = (cwd: string) =>
    act(async () => {
      const s = await invoke<Session>("create_shell", { cwd });
      onOpenInTerminal(s.name);
    });
  const openInEditor = (path: string) =>
    invoke("open_in_editor", { path }).catch((e) => setActErr(String(e)));
  const revealInFinder = (path: string) =>
    invoke("reveal_in_finder", { path }).catch((e) => setActErr(String(e)));
  const openFolderWith = (path: string) =>
    invoke("open_folder_with", { path }).catch((e) => setActErr(String(e)));

  // Jump from a conflicting filename straight to its diff under the Changes tab.
  const pickConflict = (f: string) => {
    setSelFile(f);
    setTab("changes");
  };

  if (pending.length === 0)
    return <div className={s.empty}>Nothing awaiting human review.</div>;

  const docText =
    tab === "brief" ? docs?.brief : tab === "log" ? docs?.log : docs?.review;
  const conflictsFlagged = !!preflight && !preflight.ready;
  const hb = headerBadge(preflight);

  return (
    <div className={s.root}>
      <aside className={s.rail}>
        <div className={s.railHead}>PENDING HUMAN QA</div>
        {pending.map((t) => {
          const b = railBadge(t.worktree ? rail[t.worktree]?.badge : undefined);
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
              <span className={`${s.badge} ${badgeCls(b.cls)}`}>{b.label}</span>
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
              <span className={`${s.badge} ${badgeCls(hb.cls)}`}>{hb.label}</span>
            </div>
          </div>
          {worktree && (
            <div className={s.headActions}>
              <button className="esc" onClick={() => revealInFinder(worktree)}>
                Reveal in Finder
              </button>
              <button className="esc" onClick={() => openFolderWith(worktree)}>
                Open with…
              </button>
            </div>
          )}
        </header>

        {error && <div className="error">{error}</div>}

        <nav className={s.doctabs}>
          {(["brief", "log", "review", "changes", "conflicts"] as Tab[]).map((d) => (
            <button
              key={d}
              className={`${s.doctab} ${tab === d ? s.active : ""}`}
              onClick={() => setTab(d)}
            >
              {d === "changes"
                ? `changes (${changes.length})`
                : TAB_LABELS[d]}
              {d === "conflicts" && conflictsFlagged && <span className={s.tabDot} />}
            </button>
          ))}
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
                <button
                  className="esc"
                  onClick={() => worktree && selFile && openInEditor(`${worktree}/${selFile}`)}
                >
                  Open in editor
                </button>
              }
            />
          ) : tab === "conflicts" ? (
            mergeFile && worktree ? (
              <Suspense fallback={<div className="muted">loading editor…</div>}>
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
            <pre className={s.doc}>{docText?.trim() ? docText : `(no ${TAB_LABELS[tab]})`}</pre>
          )}
        </div>

        {actErr && <div className="error">{actErr}</div>}

        <div className={s.actions}>
          <RejectButton disabled={busy} onReject={reject} />
          <button
            className={s.approve}
            disabled={busy || !preflight?.ready}
            title={preflight?.ready ? "merge into main" : "blocked — see the Conflicts tab"}
            onClick={approve}
          >
            {busy ? "…" : "Approve & merge"}
          </button>
        </div>
      </div>
    </div>
  );
}

// The merge-readiness workspace (the Conflicts tab). It walks the resolution
// through its phases: ready → root-gate → predicted-conflict (Resolve with agent
// / manually) → resolving (agent triaging) → flagged (open the merge editor) →
// all-resolved (commit). A flagged conflict keeps Approve blocked until cleared.
function ConflictsTab({
  pf,
  resolution,
  resolverActive,
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
  if (!pf) return <div className={`${s.confPad} muted`}>Checking merge readiness…</div>;
  if (pf.ready)
    return (
      <div className={s.confPad}>
        <p className={s.ready}>✓ Ready to merge — no conflicts.</p>
        <p className="muted">Review the changes, then Approve &amp; merge below.</p>
      </div>
    );

  // Root-level gates apply regardless of conflicts.
  if (!pf.onMain)
    return (
      <div className={`${s.confPad} ${s.blocked}`}>
        <div className={s.gate}>
          <span className={s.gateMsg}>
            ⚠ Repo root is on <b>{pf.currentBranch}</b>, not the main branch — switch it first.
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
          <button className="esc" disabled={busy} onClick={onShellRoot}>
            Open shell at root
          </button>
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
            <span className={s.gateMsg}>◐ Resolver agent working in the worktree…</span>
            <button className="esc" disabled={busy} onClick={onWatch}>
              Watch
            </button>
            <button className="esc danger" disabled={busy} onClick={onStop}>
              Stop
            </button>
            <button className="esc" disabled={busy} onClick={onRecheck}>
              Re-check
            </button>
          </div>
        )}

        {allResolved ? (
          <div className={s.gate}>
            <span className={s.gateMsg}>
              ✓ All conflicts resolved — commit to finish the merge.
            </span>
            <button className="go" disabled={busy} onClick={onCommit}>
              Commit resolution
            </button>
            <button className="esc danger" disabled={busy} onClick={onAbort}>
              Abort
            </button>
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
                  <button className={s.flagOpen} onClick={() => onOpenFlagged(f.file)}>
                    <span className={s.flagFile}>{f.file}</span>
                    {f.reason && <span className={s.flagReason}>{f.reason}</span>}
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
              <button className="esc" disabled={busy} onClick={onShellWorktree}>
                Open worktree shell
              </button>
              <button className="esc danger" disabled={busy} onClick={onAbort}>
                Abort resolution
              </button>
              <button className="esc" disabled={busy} onClick={onRecheck}>
                Re-check
              </button>
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
            <button key={f} className={s.conflict} onClick={() => onPickConflict(f)}>
              {f}
            </button>
          ))}
        </span>
      </div>
      <div className={s.gateActions}>
        <button className="go" disabled={busy} onClick={onResolveAgent}>
          Resolve with agent
        </button>
        <button className="esc" disabled={busy} onClick={onBegin}>
          Resolve manually
        </button>
        <button className="esc" disabled={busy} onClick={onShellWorktree}>
          Open worktree shell
        </button>
        <button className="esc" disabled={busy} onClick={onRecheck}>
          Re-check
        </button>
      </div>
    </div>
  );
}

// Maps a badge cls token (clean / conflicts / resolving) to its scoped class.
function badgeCls(cls: string): string {
  return cls === "conflicts"
    ? s.badgeConflicts
    : cls === "resolving"
      ? s.badgeResolving
      : s.badgeClean;
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
      <button className={s.reject} disabled={disabled} onClick={() => setOpen(true)}>
        Reject…
      </button>
      {open && (
        <Modal
          title="Reject — back to active"
          onClose={() => setOpen(false)}
          actions={
            <>
              <button className="ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                disabled={!reason.trim()}
                onClick={() => {
                  onReject(reason.trim());
                  setOpen(false);
                }}
              >
                Reject
              </button>
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
