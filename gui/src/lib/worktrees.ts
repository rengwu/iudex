import { useEffect, useState } from "react";
import * as api from "./api";
import type { Workspace, Worktree } from "../types";

// Enumerate the repo's physical worktrees and join each with the tickets that
// map onto it (by worktree path from `status --json`). Re-fetches whenever `ws`
// changes — `ws` is itself driven by the events.jsonl doorbell, so activating or
// merging a ticket (which adds/removes a worktree) refreshes this for free.
export function useWorktrees(root: string, ws: Workspace) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [error, setError] = useState<string | null>(null);

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
        setWorktrees(joined);
        setError(null);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [root, ws]);

  return { worktrees, error };
}
