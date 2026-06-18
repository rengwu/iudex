import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileChange, Preflight, RailCard, TaskDocs, Workspace } from "../types";

// Per-card title + merge badge for the whole pending-human-qa rail, in one
// round-trip. Re-runs when the pending set changes or on the doorbell (`ws`), so
// a freshly-resolved conflict re-badges without a manual refresh.
export function useRailStatus(
  root: string,
  mainBranch: string,
  worktrees: string[],
  ws: Workspace,
): Record<string, RailCard> {
  const [cards, setCards] = useState<Record<string, RailCard>>({});
  const key = worktrees.join("|");

  useEffect(() => {
    if (worktrees.length === 0) {
      setCards({});
      return;
    }
    let alive = true;
    invoke<RailCard[]>("rail_status", { root, mainBranch, worktrees })
      .then((cs) => {
        if (!alive) return;
        const m: Record<string, RailCard> = {};
        for (const c of cs) m[c.worktree] = c;
        setCards(m);
      })
      .catch(() => alive && setCards({}));
    return () => {
      alive = false;
    };
    // `key` stands in for the worktree array; `ws` is the doorbell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, mainBranch, key, ws]);

  return cards;
}

// Everything the Review workspace needs for one ticket: its .task/ docs, the
// three-dot changed-files list (what the ticket authored vs the merge-base), and
// the merge-preflight. Re-runs when `ws` changes (doorbell-driven) and on an
// explicit recheck() after the user resolves a conflict. `worktree` is the
// ticket's worktree path from `status --json`.
export function useReview(root: string, worktree: string | null, ws: Workspace) {
  const [docs, setDocs] = useState<TaskDocs | null>(null);
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!worktree) {
      setDocs(null);
      setChanges([]);
      setPreflight(null);
      return;
    }
    let alive = true;
    Promise.all([
      invoke<TaskDocs>("worktree_task_docs", { worktree }),
      invoke<FileChange[]>("worktree_changes", {
        worktree,
        mainBranch: ws.mainBranch,
        threeDot: true,
      }),
      invoke<Preflight>("merge_preflight", {
        root,
        worktree,
        mainBranch: ws.mainBranch,
      }),
    ])
      .then(([d, c, p]) => {
        if (!alive) return;
        setDocs(d);
        setChanges(c);
        setPreflight(p);
        setError(null);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [root, worktree, ws, nonce]);

  return { docs, changes, preflight, error, recheck };
}
