// Typed wrapper over the Tauri command surface. Every backend call goes through
// here, so command names + argument shapes live in exactly one place (mirroring
// the Rust #[tauri::command] signatures) instead of being re-stated as bare
// strings at each call site. types.ts types the data shapes; this types the
// calls. Keep these in step with src-tauri (lib.rs + tmux.rs); a mismatch shows
// up at the one call here, and TypeScript flags every consumer.
import { invoke } from "@tauri-apps/api/core";
import type {
  Workspace,
  Session,
  RailCard,
  TaskDocs,
  FileChange,
  FileDiff,
  FileView,
  Preflight,
  Resolution,
  ResolutionSummary,
  ConflictFile,
  Config,
  AgentSettings,
  ArchiveEntry,
  ArchiveDocs,
  SpecDoc,
} from "../types";

// Command return shapes that aren't reused elsewhere (so they live here, not in
// types.ts).
export type SessionStatus = { dead: boolean; exitCode: number | null };
// `resolved` is a Rust Result<String,String>: {Ok: …} | {Err: …}.
export type IudexSettings = {
  savedPath: string;
  envBin: string | null;
  bundled: boolean;
  resolved: { Ok: string } | { Err: string };
};
export type CliInstallStatus = {
  bundledVersion: string | null; // null → running unbundled; hide the section
  installedPath: string | null; // ~/.local/bin/iudex when present
  installedVersion: string | null;
  binDirOnPath: boolean;
};
export type BriefTitle = { worktree: string; title: string };
export type TicketTitle = { id: string; title: string };
// The backend Worktree (path/branch/head); the frontend joins tickets onto it.
export type RawWorktree = { path: string; branch: string; head: string };

// ── CLI availability / workspace ────────────────────────────────────────────
export const checkIudex = () => invoke<string>("check_iudex");
export const iudexStatus = (root: string) => invoke<Workspace>("iudex_status", { root });
export const watchWorkspace = (root: string) => invoke<void>("watch_workspace", { root });
export const discoverWorkspace = (start: string) =>
  invoke<string>("discover_workspace", { start });
export const initWorkspace = (path: string) => invoke<string>("init_workspace", { path });
export const runIudex = (root: string, args: string[]) =>
  invoke<string>("run_iudex", { root, args });

// ── Config / settings / prompts ─────────────────────────────────────────────
export const readConfig = (root: string) => invoke<Config>("read_config", { root });
export const writeConfig = (root: string, config: Config) =>
  invoke<void>("write_config", { root, config });
// Agent pool is machine-level (~/.iudex/config.yml) — no workspace root needed.
export const readAgentConfig = () =>
  invoke<AgentSettings>("read_agent_config");
export const writeAgentConfig = (config: AgentSettings) =>
  invoke<void>("write_agent_config", { config });
export const readPrompt = (root: string, name: string) =>
  invoke<string>("read_prompt", { root, name });
export const writePrompt = (root: string, name: string, content: string) =>
  invoke<void>("write_prompt", { root, name, content });

// ── Specifications (PRDs) ───────────────────────────────────────────────────
// Structure comes from the CLI (`iudex spec --json`, parsing single-sourced in
// internal/spec); raw markdown is a plain file read for the source pane.
export const specJson = (root: string) =>
  runIudex(root, ["spec", "--json"]).then((out) => JSON.parse(out) as SpecDoc);
export const readPrd = (root: string, file: string) =>
  invoke<string>("read_prd", { root, file });
export const getIudexSettings = () => invoke<IudexSettings>("get_iudex_settings");
export const setIudexBin = (path: string) => invoke<string>("set_iudex_bin", { path });
// The CLI bundled inside the app: install status + the ~/.local/bin symlink.
export const cliInstallStatus = () =>
  invoke<CliInstallStatus>("cli_install_status");
export const installCli = () => invoke<string>("install_cli");
// GUI behavior pref (machine-level, ~/.iudex/config.yml): kill the tmux pool on
// full app exit. Default true; off keeps agents/shells detached across a quit.
export const getKillPoolOnExit = () => invoke<boolean>("get_kill_pool_on_exit");
export const setKillPoolOnExit = (value: boolean) =>
  invoke<void>("set_kill_pool_on_exit", { value });

// ── Tickets ─────────────────────────────────────────────────────────────────
export const readQueueBrief = (root: string, id: string) =>
  invoke<string>("read_queue_brief", { root, id });
export const writeQueueBrief = (root: string, id: string, content: string) =>
  invoke<void>("write_queue_brief", { root, id, content });
export const composeTicket = (root: string, title: string, body: string, deps: string[]) =>
  invoke<void>("compose_ticket", { root, title, body, deps });

// ── Worktrees / diffs (git plumbing, read-only) ─────────────────────────────
export const listWorktrees = (root: string) => invoke<RawWorktree[]>("list_worktrees", { root });
export const worktreeChanges = (worktree: string, mainBranch: string, threeDot?: boolean) =>
  invoke<FileChange[]>("worktree_changes", { worktree, mainBranch, threeDot });
export const worktreeFileDiff = (
  worktree: string,
  path: string,
  mainBranch: string,
  threeDot?: boolean,
) => invoke<FileDiff>("worktree_file_diff", { worktree, path, mainBranch, threeDot });
// Read-only "all files" browser: the gitignored-filtered file list, and one
// file's current on-disk content.
export const listTree = (worktree: string) => invoke<string[]>("list_tree", { worktree });
export const readFile = (worktree: string, path: string) =>
  invoke<FileView>("read_file", { worktree, path });
export const worktreeTaskDocs = (worktree: string) =>
  invoke<TaskDocs>("worktree_task_docs", { worktree });
// Count of uncommitted changes (excluding .task/) — used to warn before a manual
// finish, whose auto-WIP-commit would otherwise ship unready edits to QA.
export const worktreeDirtyCount = (worktree: string) =>
  invoke<number>("worktree_dirty_count", { worktree });

// ── Review / merge preflight / conflict resolution ──────────────────────────
export const railStatus = (root: string, mainBranch: string, worktrees: string[]) =>
  invoke<RailCard[]>("rail_status", { root, mainBranch, worktrees });
export const mergePreflight = (root: string, worktree: string, mainBranch: string) =>
  invoke<Preflight>("merge_preflight", { root, worktree, mainBranch });
export const beginResolution = (worktree: string, mainBranch: string) =>
  invoke<boolean>("begin_resolution", { worktree, mainBranch });
export const abortResolution = (worktree: string) =>
  invoke<void>("abort_resolution", { worktree });
export const readResolution = (worktree: string) =>
  invoke<Resolution>("read_resolution", { worktree });
export const resolutionSummary = (worktree: string, mainBranch: string) =>
  invoke<ResolutionSummary>("resolution_summary", { worktree, mainBranch });
export const readConflictFile = (worktree: string, path: string) =>
  invoke<ConflictFile>("read_conflict_file", { worktree, path });
export const writeResolvedFile = (worktree: string, path: string, content: string) =>
  invoke<void>("write_resolved_file", { worktree, path, content });
export const commitResolution = (worktree: string) =>
  invoke<void>("commit_resolution", { worktree });

// ── Archive ─────────────────────────────────────────────────────────────────
export const listArchives = (root: string) => invoke<ArchiveEntry[]>("list_archives", { root });
export const readArchive = (root: string, id: string) =>
  invoke<ArchiveDocs>("read_archive", { root, id });

// ── OS escape hatches ───────────────────────────────────────────────────────
export const openInEditor = (path: string) => invoke<void>("open_in_editor", { path });
export const revealInFinder = (path: string) => invoke<void>("reveal_in_finder", { path });
export const openFolderWith = (path: string) => invoke<void>("open_folder_with", { path });

// ── tmux pool / sessions / agents ───────────────────────────────────────────
export const tmuxAvailable = () => invoke<boolean>("tmux_available");
export const listSessions = (root: string) => invoke<Session[]>("list_sessions", { root });
export const sessionStatus = (name: string) => invoke<SessionStatus>("session_status", { name });
export const capturePane = (name: string, lines: number) =>
  invoke<string>("capture_pane", { name, lines });
export const killSession = (name: string) => invoke<void>("kill_session", { name });
export const createShell = (root: string, cwd?: string) =>
  invoke<Session>("create_shell", { root, cwd });
export const spawnAgent = (root: string, ticket: string, role: string) =>
  invoke<Session>("spawn_agent", { root, ticket, role });
export const spawnIdea = (root: string, skill: string, seed: string) =>
  invoke<Session>("spawn_idea", { root, skill, seed });
export const spawnResolver = (root: string, ticket: string, worktree: string) =>
  invoke<Session>("spawn_resolver", { root, ticket, worktree });
export const briefTitles = (worktrees: string[]) =>
  invoke<BriefTitle[]>("brief_titles", { worktrees });
export const ticketTitles = (root: string) =>
  invoke<TicketTitle[]>("ticket_titles", { root });

// ── Terminal PTY bridge ─────────────────────────────────────────────────────
export const openTerminal = (
  id: string,
  name: string,
  readonly: boolean,
  cols: number,
  rows: number,
) => invoke<void>("open_terminal", { id, name, readonly, cols, rows });
export const writeTerminal = (id: string, data: string) =>
  invoke<void>("write_terminal", { id, data });
export const resizeTerminal = (id: string, cols: number, rows: number) =>
  invoke<void>("resize_terminal", { id, cols, rows });
export const closeTerminal = (id: string) => invoke<void>("close_terminal", { id });
