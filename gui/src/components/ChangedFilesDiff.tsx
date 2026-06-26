import { Suspense, lazy, type ReactNode } from "react";
import type { FileChange, FileDiff } from "../types";
import s from "./ChangedFilesDiff.module.scss";

const DiffViewer = lazy(() => import("../views/DiffViewer"));

// The changed-files list + diff panel, shared by every view that inspects a
// worktree's changes (Worktrees, Review's changes tab, Agents' worktree tab).
// Presentational: the caller owns fetching (two-dot vs three-dot, which
// worktree) and passes the current `changes`, the `selected` file, and its
// loaded `diff`.
export default function ChangedFilesDiff({
  changes,
  selected,
  onSelect,
  diff,
  error,
  noChangesHint = "no changes",
  pickHint = "Pick a file to view its diff.",
  fileActions,
}: {
  changes: FileChange[];
  selected: string | null;
  onSelect: (path: string) => void;
  diff: FileDiff | null;
  error?: string | null;
  noChangesHint?: string;
  pickHint?: string;
  fileActions?: ReactNode;
}) {
  return (
    <div className={s.split}>
      <ul className={s.fileList}>
        {error && <li className="error">{error}</li>}
        {!error && changes.length === 0 && (
          <li className="muted" style={{ margin: "8px" }}>
            {noChangesHint}
          </li>
        )}
        {changes.map((c) => (
          <li
            key={c.path}
            className={`${s.file} ${c.path === selected ? s.active : ""}`}
            onClick={() => onSelect(c.path)}
          >
            <span className={`${s.st} ${s[`st${c.status}`] ?? ""}`}>
              {c.status}
            </span>
            <span className={s.path}>{c.path}</span>
            {c.additions ? <span className={s.add}>+{c.additions}</span> : null}
            {c.deletions ? <span className={s.del}>−{c.deletions}</span> : null}
          </li>
        ))}
      </ul>
      <div className={s.diff}>
        {selected && diff ? (
          <Suspense fallback={<div className="muted">loading editor…</div>}>
            <DiffViewer
              original={diff.original}
              modified={diff.modified}
              language={diff.language}
              title={selected}
              actions={fileActions}
            />
          </Suspense>
        ) : (
          <div className={s.empty}>
            {changes.length > 0 && !selected ? pickHint : ""}
          </div>
        )}
      </div>
    </div>
  );
}
