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
