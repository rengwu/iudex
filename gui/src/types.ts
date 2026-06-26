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
  blocks?: string[];
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

// The `.task/` docs for a ticket (from `worktree_task_docs`).
export interface TaskDocs {
  brief: string;
  log: string;
  review: string;
}

// One Review-rail card (from `rail_status`): a human title plus a coarse merge
// badge, so the rail can be triaged without opening each ticket.
export interface RailCard {
  worktree: string;
  title: string;
  badge: "clean" | "conflicts" | "resolving";
}

// One conflicted file the agent flagged for human judgment (or any still-unmerged
// file, with the agent's reason when it gave one).
export interface FlaggedItem {
  file: string;
  reason: string;
}

// A conflict the agent resolved on its own (informational, from its report).
export interface ResolvedItem {
  file: string;
  note: string;
}

// The state of an in-worktree conflict resolution (from `read_resolution`):
// whether a merge is underway, git's authoritative unmerged set, and the agent's
// triage report joined onto it.
export interface Resolution {
  mergeInProgress: boolean;
  unmerged: string[];
  flagged: FlaggedItem[];
  resolved: ResolvedItem[];
  hasReport: boolean;
}

// A committed conflict resolution, summarized for the ready/Conflicts tab (from
// `resolution_summary`). `patch` is the resolver's edits as a unified diff.
export interface ResolutionSummary {
  resolved: boolean;
  patch: string;
}

// One conflicted file's three sides for the merge editor (from
// `read_conflict_file`): `merged` is the working file with conflict markers.
export interface ConflictFile {
  ours: string;
  theirs: string;
  merged: string;
  language: string;
}

// The merge-preflight for a pending-human-qa ticket (from `merge_preflight`):
// predicts whether `iudex human-qa approve` would succeed.
export interface Preflight {
  currentBranch: string;
  onMain: boolean;
  clean: boolean;
  dirtyFiles: string[];
  wouldConflict: boolean;
  conflictFiles: string[];
  mergeInProgress: boolean;
  ready: boolean;
}

// The editable `.iudex/config.yml` scalar fields (from `read_config`/
// `write_config`). The agent-command pool lives separately (see AgentSettings).
export interface Config {
  mainBranch: string;
  maxActive: number;
  qaRejectLimit: number;
  mergeStrategy: string;
  mergeMessageTemplate: string;
  branchPrefix: string;
}

// One named entry in the agent-command pool.
export interface AgentCmd {
  name: string;
  command: string;
  default: boolean;
}

// The agent pool + per-role map (from `read_agent_config`/`write_agent_config`).
// `roles` maps a role name (impl, qa, resolve, idea) to a pool entry's name; an
// absent role uses the default entry.
export interface AgentSettings {
  commands: AgentCmd[];
  roles: Record<string, string>;
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

// One archived ticket (from `list_archives`): outcome "done" (merged) or
// "removed" (abandoned). The Archive view's Review tab shows the merged ones.
export interface ArchiveEntry {
  id: string;
  outcome: string;
  title: string;
  archivedAt: string;
  mergeCommit: string;
  qaRejects: number;
  deps: string[]; // prerequisite ids, recovered from the archived queue event
}

// The archived docs + final diff for one ticket (from `read_archive`).
export interface ArchiveDocs {
  brief: string;
  log: string;
  review: string;
  diff: string;
}

// The top-level views, in nav order. Dashboard is the default landing.
export type View =
  | "dashboard"
  | "terminal"
  | "tickets"
  | "agents"
  | "worktrees"
  | "review"
  | "archive"
  | "settings";

export type ViewConfig = { id: View; label: string; dot: string };

// Per-view config — id, nav label, and status-dot color (gui/design-system/README.md §4). Keyed by
// view id so callers can read a view's dot directly (VIEWS.agents.dot), making
// this the single source for those colors (ViewHeaders read from here rather
// than hardcoding hex). Record<View, …> is exhaustive: a new View won't compile
// until it has an entry. Key order is the rail display order (see RAIL_* below).
export const VIEWS: Record<View, ViewConfig> = {
  dashboard: { id: "dashboard", label: "Dashboard", dot: "#f4bc41" },
  terminal: { id: "terminal", label: "Terminal", dot: "#343fd5" },
  tickets: { id: "tickets", label: "Tickets", dot: "#5bc7d8" },
  agents: { id: "agents", label: "Agents", dot: "#5ccf5c" },
  worktrees: { id: "worktrees", label: "Worktrees", dot: "#9ea0e0" },
  review: { id: "review", label: "Review", dot: "#836ddd" },
  archive: { id: "archive", label: "Archive", dot: "#7fb3a8" },
  settings: { id: "settings", label: "Settings", dot: "#8a8f99" },
};

// Side-channel views, pinned to the bottom of the rail (above the pipeline) —
// useful but not part of the core queue→implement→QA→review→merge workflow.
// Settings sits last in this group.
const SECONDARY_IDS: View[] = ["worktrees", "archive", "settings"];

// The left-nav rail, split into a top (core workflow) and bottom (secondary)
// group.
export const RAIL_VIEWS = Object.values(VIEWS).filter((v) => !SECONDARY_IDS.includes(v.id));
export const RAIL_SECONDARY = Object.values(VIEWS).filter((v) => SECONDARY_IDS.includes(v.id));
