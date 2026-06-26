import { useCallback, useEffect, useState } from "react";
import * as api from "./api";
import type {
  FileChange,
  Preflight,
  RailCard,
  Resolution,
  TaskDocs,
  Workspace,
} from "../types";

// Per-card title + merge badge for the whole pending-human-qa rail, in one
// round-trip. Re-runs when the pending set changes or on the doorbell (`ws`), so
// a freshly-resolved conflict re-badges without a manual refresh.
export function useRailStatus(
  root: string,
  mainBranch: string,
  worktrees: string[],
  ws: Workspace,
  // Bumps to force a re-fetch outside the doorbell — e.g. a worktree merge (which
  // fires no events.jsonl change) flipping a card between conflicts/resolving/clean.
  refreshKey?: string | number,
): Record<string, RailCard> {
  const [cards, setCards] = useState<Record<string, RailCard>>({});
  const key = worktrees.join("|");

  useEffect(() => {
    if (worktrees.length === 0) {
      setCards({});
      return;
    }
    let alive = true;
    api
      .railStatus(root, mainBranch, worktrees)
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
    // `key` stands in for the worktree array; `ws` is the doorbell; `refreshKey`
    // covers merge-state changes that don't touch events.jsonl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, mainBranch, key, ws, refreshKey]);

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
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!worktree) {
      setDocs(null);
      setChanges([]);
      setPreflight(null);
      setResolution(null);
      return;
    }
    let alive = true;
    Promise.all([
      api.worktreeTaskDocs(worktree),
      api.worktreeChanges(worktree, ws.mainBranch, true),
      api.mergePreflight(root, worktree, ws.mainBranch),
      api.readResolution(worktree),
    ])
      .then(([d, c, p, r]) => {
        if (!alive) return;
        setDocs(d);
        setChanges(c);
        setPreflight(p);
        setResolution(r);
        setError(null);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [root, worktree, ws, nonce]);

  return { docs, changes, preflight, resolution, error, recheck };
}
