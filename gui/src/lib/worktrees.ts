import { useCallback, useEffect, useState } from "react";
import * as api from "./api";
import type { Workspace, Worktree } from "../types";

// Enumerate the repo's physical worktrees and join each with the tickets that
// map onto it (by worktree path from `status --json`). Re-fetches whenever `ws`
// changes — `ws` is itself driven by the events.jsonl doorbell, so activating or
// merging a ticket (which adds/removes a worktree) refreshes this for free.
//
// The repo root (the canonical main worktree, which `list_worktrees` drops) is
// prepended as a synthetic `isMain` entry so the codebase is always browsable —
// it has no diff-vs-main, only the read-only "all files" mode.
export function useWorktrees(root: string, ws: Workspace) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Bumped by `reload()` to re-enumerate: removing an orphaned worktree writes
  // no events.jsonl, so it rings no doorbell — the caller re-fetches manually.
  const [reloadN, setReloadN] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .listWorktrees(root)
      .then((raws) => {
        if (!alive) return;
        const joined = raws.map((w) => ({
          ...w,
          tickets: ws.tickets
            .filter((t) => t.worktree === w.path)
            .map((t) => ({ id: t.id, state: t.state })),
        }));
        const main: Worktree = {
          path: root,
          branch: ws.mainBranch,
          head: "",
          tickets: [],
          isMain: true,
        };
        setWorktrees([main, ...joined]);
        setError(null);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [root, ws, reloadN]);

  const reload = useCallback(() => setReloadN((n) => n + 1), []);

  return { worktrees, error, reload };
}

// Orphan detection: an orphaned worktree is the residue of best-effort cleanup —
// a physical worktree under .iudex/worktrees/tN whose ticket is terminal
// (done/removed) or has no record. Uses the id from the directory name, not the
// `t.worktree === w.path` join (terminal tickets may no longer carry a worktree
// path). Worktrees outside .iudex/worktrees/ (and the main root) are never
// flagged. Returns the human sentence for the detail header, or null if not an
// orphan.
export function orphanReason(w: Worktree, ws: Workspace): string | null {
  if (w.isMain) return null;
  const parts = w.path.split("/");
  const base = parts[parts.length - 1];
  const parent = parts.slice(-3, -1).join("/");
  if (parent !== ".iudex/worktrees" || !/^t\d+$/.test(base)) return null;
  const t = ws.tickets.find((x) => x.id === base);
  if (!t) return `${base} has no ticket record.`;
  if (t.state === "done" || t.state === "removed") {
    return `${base} is ${t.state} — cleanup didn't complete.`;
  }
  return null;
}
