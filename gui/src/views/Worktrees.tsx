import { Fragment, Suspense, lazy, useEffect, useState } from "react";
import * as api from "../lib/api";
import {
  VIEWS,
  type FileChange,
  type FileDiff,
  type FileView,
  type Workspace,
  type Worktree,
} from "../types";
import { useWorktrees } from "../lib/worktrees";
import { useNav } from "../lib/nav";
import Badge from "../components/Badge";
import ViewHeader from "../components/ViewHeader";
import Button from "../components/Button";
import FileTree from "./FileTree";
import s from "./Worktrees.module.scss";

// Monaco is heavy; load the diff/file surfaces only when first needed.
const DiffViewer = lazy(() => import("./DiffViewer"));
const FileViewer = lazy(() => import("./FileViewer"));

// A worktree's display name: its branch, or the dir basename when detached.
function wtLabel(w: Worktree): string {
  return w.branch || w.path.split("/").pop() || w.path;
}

// Read-only, editor-style inspection of any worktree. Pick a worktree (left),
// then either its changed files vs main (the diff mode) or its full file tree
// (the "all files" browser) — with escape hatches out to a real editor / shell.
// The rail is keyed on physical worktrees, not tickets, so a worktree appears
// once even if several tickets map onto it; the relationship shows as ticket
// badges. The repo root ("main") is pinned on top and offers only the browser.
export default function Worktrees({
  ws,
  root,
}: {
  ws: Workspace;
  root: string;
}) {
  const { goTo } = useNav();
  const { worktrees, error } = useWorktrees(root, ws);

  const [selPath, setSelPath] = useState<string | null>(null);
  const [mode, setMode] = useState<"changed" | "all">("changed");
  const [paneErr, setPaneErr] = useState<string | null>(null);

  // Changed-files (diff) mode state.
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [selFile, setSelFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);

  // "All files" browser state. `treeReload` bumps to re-fetch (the refresh
  // button) — file content never rings the events.jsonl doorbell, so a manual
  // refresh is the honest way to pick up on-disk edits.
  const [tree, setTree] = useState<string[]>([]);
  const [treeFile, setTreeFile] = useState<string | null>(null);
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [treeReload, setTreeReload] = useState(0);

  const selected = worktrees.find((w) => w.path === selPath) ?? null;
  const isMain = selected?.isMain ?? false;

  // Default-select the first worktree (main); keep selection valid as the list changes.
  useEffect(() => {
    if (worktrees.length === 0) {
      setSelPath(null);
    } else if (!worktrees.some((w) => w.path === selPath)) {
      setSelPath(worktrees[0].path);
    }
  }, [worktrees, selPath]);

  // Reset to the right mode when the selection changes: main is browser-only.
  useEffect(() => {
    setMode(isMain ? "all" : "changed");
  }, [selPath, isMain]);

  // Changed-files mode: load the changed-file list.
  useEffect(() => {
    if (!selPath || mode !== "changed") {
      setChanges([]);
      setSelFile(null);
      setDiff(null);
      return;
    }
    let alive = true;
    api
      .worktreeChanges(selPath, ws.mainBranch)
      .then((c) => {
        if (!alive) return;
        setChanges(c);
        setSelFile(c[0]?.path ?? null); // default-select the first file
        setPaneErr(null);
      })
      .catch((e) => alive && setPaneErr(String(e)));
    return () => {
      alive = false;
    };
  }, [selPath, mode, ws.mainBranch]);

  // Changed-files mode: load the diff for the selected file.
  useEffect(() => {
    if (!selPath || !selFile || mode !== "changed") {
      setDiff(null);
      return;
    }
    let alive = true;
    api
      .worktreeFileDiff(selPath, selFile, ws.mainBranch)
      .then((d) => alive && setDiff(d))
      .catch((e) => alive && setPaneErr(String(e)));
    return () => {
      alive = false;
    };
  }, [selPath, selFile, mode, ws.mainBranch]);

  // "All files" mode: load the tree, keeping the open file selected if it survives.
  useEffect(() => {
    if (!selPath || mode !== "all") {
      setTree([]);
      setTreeFile(null);
      setFileView(null);
      return;
    }
    let alive = true;
    api
      .listTree(selPath)
      .then((t) => {
        if (!alive) return;
        setTree(t);
        setTreeFile((prev) => (prev && t.includes(prev) ? prev : (t[0] ?? null)));
        setPaneErr(null);
      })
      .catch((e) => alive && setPaneErr(String(e)));
    return () => {
      alive = false;
    };
  }, [selPath, mode, treeReload]);

  // "All files" mode: load the selected file's on-disk content.
  useEffect(() => {
    if (!selPath || !treeFile || mode !== "all") {
      setFileView(null);
      return;
    }
    let alive = true;
    api
      .readFile(selPath, treeFile)
      .then((f) => alive && setFileView(f))
      .catch((e) => alive && setPaneErr(String(e)));
    return () => {
      alive = false;
    };
  }, [selPath, treeFile, mode, treeReload]);

  const openInEditor = (file: string) =>
    api.openInEditor(`${selPath}/${file}`).catch((e) => setPaneErr(String(e)));

  const openShell = async () => {
    if (!selPath) return;
    try {
      const sess = await api.createShell(root, selPath);
      goTo("terminal", { id: sess.name });
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
    { add: 0, del: 0 },
  );

  if (error) return <div className="error">{error}</div>;

  return (
    <div className={s.wrap}>
      <ViewHeader
        dot={VIEWS.worktrees.dot}
        title="Worktrees"
        subtitle="read-only inspection · diff vs main or full-tree browse"
      />
      <div className={s.root}>
        <aside className={s.rail}>
          <div className={s.railHead}>WORKTREES</div>
          {worktrees.map((w) => (
            <button
              key={w.path}
              className={`${s.item} ${w.path === selPath ? s.active : ""}`}
              onClick={() => setSelPath(w.path)}
            >
              <span className={s.branch}>{wtLabel(w)}</span>
              <span className={s.badges}>
                {w.isMain ? (
                  <Badge bg="#c7a24e" fg="#2a2a2a">
                    main
                  </Badge>
                ) : w.tickets.length === 0 ? (
                  <Badge bg="#9c9c9c" fg="#565656">
                    no ticket
                  </Badge>
                ) : (
                  w.tickets.map((t) => (
                    <Fragment key={t.id}>
                      <Badge>{t.id}</Badge>
                      <Badge kind="state" value={t.state} />
                    </Fragment>
                  ))
                )}
              </span>
            </button>
          ))}
        </aside>

        <div className={s.content}>
          <div className={s.worktreeHead}>
            {selected && (
              <>
                <span className={s.worktreeHeadInfo}>
                  {mode === "all"
                    ? `${wtLabel(selected)}${isMain ? " · read-only" : " · all files"}`
                    : `${wtLabel(selected)} · ${selected.head.slice(0, 7)} · vs ${ws.mainBranch}`}
                </span>
                <div className={s.headTools}>
                  {!isMain && (
                    <div className={s.seg}>
                      <button
                        className={mode === "changed" ? s.on : ""}
                        onClick={() => setMode("changed")}
                      >
                        changed files
                      </button>
                      <button
                        className={mode === "all" ? s.on : ""}
                        onClick={() => setMode("all")}
                      >
                        all files
                      </button>
                    </div>
                  )}
                  {mode === "all" && (
                    <Button
                      variant="quiet"
                      size="sm"
                      onClick={() => setTreeReload((n) => n + 1)}
                    >
                      ↻ refresh
                    </Button>
                  )}
                  <Button variant="quiet" size="sm" onClick={openShell}>
                    Launch Terminal Session
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className={s.panes}>
            <div className={s.files}>
              {mode === "all" ? (
                <>
                  {tree.length === 0 ? (
                    <div className="muted" style={{ margin: "8px" }}>
                      no files
                    </div>
                  ) : (
                    <FileTree
                      paths={tree}
                      selected={treeFile}
                      onSelect={setTreeFile}
                    />
                  )}
                  {tree.length > 0 && (
                    <div className={s.filesFoot}>
                      {tree.length} file{tree.length === 1 ? "" : "s"}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <ul className={s.filelist}>
                    {changes.length === 0 && (
                      <li className="muted" style={{ margin: "8px" }}>
                        no changes vs {ws.mainBranch}
                      </li>
                    )}
                    {changes.map((c) => (
                      <li
                        key={c.path}
                        className={`${s.file} ${c.path === selFile ? s.active : ""}`}
                        onClick={() => setSelFile(c.path)}
                      >
                        <span className={`${s.st} ${s[`st${c.status}`] ?? ""}`}>
                          {c.status}
                        </span>
                        <span className={s.path}>{c.path}</span>
                      </li>
                    ))}
                  </ul>
                  {changes.length > 0 && (
                    <div className={s.filesFoot}>
                      {changes.length} file{changes.length === 1 ? "" : "s"}
                      {(totals.add > 0 || totals.del > 0) && (
                        <>
                          {" "}
                          <span className={s.add}>+{totals.add}</span>{" "}
                          <span className={s.del}>−{totals.del}</span>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className={s.diff}>
              {paneErr && <div className="error">{paneErr}</div>}
              {mode === "all" ? (
                treeFile && fileView ? (
                  <Suspense
                    fallback={<div className={s.loading}>loading editor…</div>}
                  >
                    <FileViewer
                      content={fileView.content}
                      language={fileView.language}
                      title={treeFile}
                      actions={
                        <Button
                          variant="quiet"
                          size="sm"
                          onClick={() => openInEditor(treeFile)}
                        >
                          Open in editor
                        </Button>
                      }
                    />
                  </Suspense>
                ) : (
                  <div className={s.diffEmpty}>
                    {tree.length > 0 ? "Select a file to view it." : ""}
                  </div>
                )
              ) : selFile && diff ? (
                <Suspense
                  fallback={<div className={s.loading}>loading editor…</div>}
                >
                  <DiffViewer
                    original={diff.original}
                    modified={diff.modified}
                    language={diff.language}
                    title={selFile}
                    actions={
                      <Button
                        variant="quiet"
                        size="sm"
                        onClick={() => openInEditor(selFile)}
                      >
                        Open in editor
                      </Button>
                    }
                  />
                </Suspense>
              ) : (
                <div className={s.diffEmpty}>
                  {changes.length > 0 ? "Select a file to view its diff." : ""}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
