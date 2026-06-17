// Mirrors the `iudex status --json` contract. The GUI holds no authoritative
// state of its own; every field here comes from replaying events.jsonl in the
// CLI, surfaced through that one read path.
export interface Ticket {
  id: string;
  state: string;
  deps: string[];
  qaRejects: number;
  ready: boolean;
  blockedBy: string[];
  hasWorktree: boolean;
  worktree?: string;
}

export interface Workspace {
  mainBranch: string;
  maxActive: number;
  qaRejectLimit: number;
  tickets: Ticket[];
}

// A physical git worktree (from `list_worktrees`), joined on the frontend with
// the tickets that map onto it. Keyed by `path`, so it appears once even if more
// than one ticket references it; the relationship shows as ticket badges.
export interface Worktree {
  path: string;
  branch: string;
  head: string;
  tickets: { id: string; state: string }[];
}

// A changed file in a worktree vs main (from `worktree_changes`).
export interface FileChange {
  path: string;
  status: string; // "A" | "M" | "D" | "R" | "U"
  additions?: number | null;
  deletions?: number | null;
}

// Base vs head content for one file (from `worktree_file_diff`).
export interface FileDiff {
  original: string;
  modified: string;
  language: string;
}

// A session in the unified tmux pool, mirroring the Rust `Session` struct.
export interface Session {
  name: string;
  kind: "agent" | "shell" | "idea";
  ticket: string | null;
  role?: string | null; // agent's role at spawn ("impl" | "qa")
  started?: string | null; // agent spawn time (unix millis string, sortable)
  title: string;
}

// The seven top-level views, in nav order. Dashboard is the default landing.
export type View =
  | "dashboard"
  | "terminal"
  | "tickets"
  | "agents"
  | "worktrees"
  | "review"
  | "settings";

export const VIEWS: { id: View; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "terminal", label: "Terminal" },
  { id: "tickets", label: "Tickets" },
  { id: "agents", label: "Agents" },
  { id: "worktrees", label: "Worktrees" },
  { id: "review", label: "Review" },
  { id: "settings", label: "Settings" },
];
