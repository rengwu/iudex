import { useEffect, useState } from "react";
import * as api from "./api";
import type { TaskDocs, Ticket } from "../types";

// Fetches a ticket's .task/ docs (brief + log + review) from whichever location
// they currently live: worktree's .task/ for active+ tickets, or .iudex/queue/
// for queued tickets that have never been activated.
export function useTicketDocs(
  root: string,
  ticket: Ticket | null,
): { docs: TaskDocs | null; loading: boolean } {
  const [docs, setDocs] = useState<TaskDocs | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!ticket) {
      setDocs(null);
      return;
    }
    let alive = true;
    setLoading(true);
    const fetch: Promise<TaskDocs> = ticket.worktree
      ? api.worktreeTaskDocs(ticket.worktree)
      : api.readQueueBrief(root, ticket.id).then((b) => ({
          brief: b,
          log: "",
          review: "",
        }));

    fetch
      .then((d) => { if (alive) setDocs(d); })
      .catch(() => { if (alive) setDocs(null); })
      .finally(() => { if (alive) setLoading(false); });

    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, ticket?.id, ticket?.worktree]);

  return { docs, loading };
}
