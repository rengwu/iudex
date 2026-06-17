import { Suspense, lazy, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileChange, FileDiff, Session, Workspace, Worktree } from "../types";
import { useWorktrees } from "../lib/worktrees";

// Monaco is heavy; load it only when this view first needs a diff.
const DiffViewer = lazy(() => import("./DiffViewer"));

// A worktree's display name: its branch, or the dir basename when detached.
function wtLabel(w: Worktree): string {
  return w.branch || w.path.split("/").pop() || w.path;
}

// Read-only, editor-style inspection of any worktree: pick a worktree (left),
// see its changed files vs main (middle), read the diff in Monaco (right), with
// escape hatches out to a real editor / shell. The rail is keyed on physical
// worktrees, not tickets, so a worktree appears once even if several tickets map
// onto it; the relationship shows as ticket badges.
export default function Worktrees({
  ws,
  root,
  onOpenInTerminal,
}: {
  ws: Workspace;
  root: string;
  onOpenInTerminal: (session: string) => void;
}) {
  const { worktrees, error } = useWorktrees(root, ws);

  const [selPath, setSelPath] = useState<string | null>(null);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [selFile, setSelFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [paneErr, setPaneErr] = useState<string | null>(null);

  const selected = worktrees.find((w) => w.path === selPath) ?? null;

  // Default-select the first worktree; keep selection valid as the list changes.
  useEffect(() => {
    if (worktrees.length === 0) {
      setSelPath(null);
    } else if (!worktrees.some((w) => w.path === selPath)) {
      setSelPath(worktrees[0].path);
    }
  }, [worktrees, selPath]);

  // Load the changed-files list when the selected worktree changes.
  useEffect(() => {
    setSelFile(null);
    setDiff(null);
    if (!selPath) {
      setChanges([]);
      return;
    }
    let alive = true;
    invoke<FileChange[]>("worktree_changes", {
      worktree: selPath,
      mainBranch: ws.mainBranch,
    })
      .then((c) => {
        if (!alive) return;
        setChanges(c);
        setPaneErr(null);
      })
      .catch((e) => alive && setPaneErr(String(e)));
    return () => {
      alive = false;
    };
  }, [selPath, ws.mainBranch]);

  // Load the diff for the selected file.
  useEffect(() => {
    if (!selPath || !selFile) {
      setDiff(null);
      return;
    }
    let alive = true;
    invoke<FileDiff>("worktree_file_diff", {
      worktree: selPath,
      path: selFile,
      mainBranch: ws.mainBranch,
    })
      .then((d) => alive && setDiff(d))
      .catch((e) => alive && setPaneErr(String(e)));
    return () => {
      alive = false;
    };
  }, [selPath, selFile, ws.mainBranch]);

  const openInEditor = (file: string) =>
    invoke("open_in_editor", { path: `${selPath}/${file}` }).catch((e) =>
      setPaneErr(String(e))
    );

  const openShell = async () => {
    try {
      const s = await invoke<Session>("create_shell", { cwd: selPath });
      onOpenInTerminal(s.name);
    } catch (e) {
      setPaneErr(String(e));
    }
  };

  const totals = changes.reduce(
    (acc, c) => {
      acc.add += c.additions ?? 0;
      acc.del += c.deletions ?? 0;
      return acc;
    },
    { add: 0, del: 0 }
  );

  if (error) return <div className="error">{error}</div>;
  if (worktrees.length === 0)
    return <div className="wt-empty">No active worktrees. Activate a ticket to create one.</div>;

  return (
    <div className="wt">
      <aside className="wt-rail">
        <div className="wt-rail-head">WORKTREES</div>
        {worktrees.map((w) => (
          <button
            key={w.path}
            className={`wt-item${w.path === selPath ? " active" : ""}`}
            onClick={() => setSelPath(w.path)}
          >
            <span className="wt-branch">{wtLabel(w)}</span>
            <span className="wt-badges">
              {w.tickets.length === 0 ? (
                <span className="wt-badge muted">no ticket</span>
              ) : (
                w.tickets.map((t) => (
                  <span key={t.id} className={`wt-badge state-${t.state}`}>
                    {t.id} · {t.state}
                  </span>
                ))
              )}
            </span>
          </button>
        ))}
      </aside>

      <div className="wt-files">
        <div className="wt-files-head">
          {selected ? wtLabel(selected) : ""} <span className="muted">· vs {ws.mainBranch}</span>
        </div>
        <ul className="wt-filelist">
          {changes.length === 0 && <li className="muted">no changes vs {ws.mainBranch}</li>}
          {changes.map((c) => (
            <li
              key={c.path}
              className={`wt-file${c.path === selFile ? " active" : ""}`}
              onClick={() => setSelFile(c.path)}
            >
              <span className={`wt-st wt-st-${c.status}`}>{c.status}</span>
              <span className="wt-path">{c.path}</span>
            </li>
          ))}
        </ul>
        {changes.length > 0 && (
          <div className="wt-files-foot">
            {changes.length} file{changes.length === 1 ? "" : "s"}
            {(totals.add > 0 || totals.del > 0) && (
              <>
                {" "}
                <span className="add">+{totals.add}</span>{" "}
                <span className="del">−{totals.del}</span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="wt-diff">
        {paneErr && <div className="error">{paneErr}</div>}
        {selFile && diff ? (
          <Suspense fallback={<div className="wt-loading">loading editor…</div>}>
            <DiffViewer
              original={diff.original}
              modified={diff.modified}
              language={diff.language}
              title={selFile}
              actions={
                <>
                  <button className="wt-esc" onClick={() => openInEditor(selFile)}>
                    Open in editor
                  </button>
                  <button className="wt-esc" onClick={openShell}>
                    Shell
                  </button>
                </>
              }
            />
          </Suspense>
        ) : (
          <div className="wt-diff-empty">
            {changes.length > 0 ? "Select a file to view its diff." : ""}
          </div>
        )}
      </div>
    </div>
  );
}
