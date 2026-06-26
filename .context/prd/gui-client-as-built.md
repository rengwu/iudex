# PRD — iudex GUI Client (As-Built)

> An **as-built companion** to `gui-client.md`. Where that document captured the _design intent_ hardened through a grill-me session, this one documents **what actually exists in `gui/` today** — the real command surface, the real views, and every place the implementation deviated from or extended the original plan. When the two disagree, this document describes the running code.
>
> Written 2026-06-19, branch `feat/gui-read-path` (22 commits off `main`, not yet merged). Code lives in `gui/`; per-commit detail is in the git history.

---

## 1. What it is

A native **Tauri 2** desktop client (Rust backend, React 19 + TypeScript frontend) that drives the `iudex` CLI the way a git client drives `git`. It holds **no authoritative state**: it **writes** by shelling every mutation through the `iudex` binary, **reads** derived truth via `iudex status --json`, and watches `.iudex/events.jsonl` as a _doorbell_ (re-reads on any change). It never reimplements iudex's `Derive` replay logic, so the GUI and CLI cannot diverge.

It does own the one thing the CLI deliberately won't: **agent process supervision**, via a unified **tmux session pool**.

**Architecture in one line:** a stateless Tauri shell over two live substrates — tmux (agent sessions) + `events.jsonl` (ticket truth) — that writes via `iudex` and reads via `iudex … --json`.

### The core invariant (load-bearing)

1. **Write path** = shell out to `iudex` (`run_iudex(root, args)`). Every state transition is a real CLI invocation.
2. **Read path** = `iudex status --json`, parsed into a `Workspace` view model. The GUI is the _filter_; the CLI returns the whole truth.
3. **Doorbell** = a `notify` watcher on `.iudex/`. On any `events.jsonl` change the backend emits `events-changed`; the frontend re-reads. No polling of ticket state.
4. **Git reads** (worktree diffs, merge-tree conflict prediction) shell `git -C <dir>` directly from Rust — plain plumbing, not state-machine logic, so they deliberately stay out of the CLI.

---

## 2. The one upstream change to iudex

The GUI required exactly one addition inside the iudex repo: **`iudex status --json`** (landed). It emits a top-level object and, per ticket, the fields the GUI cannot cheaply recompute without replicating the state machine:

```jsonc
{
  "mainBranch": "main",
  "maxActive": 4,
  "qaRejectLimit": 3,
  "tickets": [
    {
      "id": "t1",
      "state": "active",
      "deps": ["t2"],
      "blockedBy": [],
      "blocks": ["t5"],
      "qaRejects": 0,
      "ready": true,
      "hasWorktree": true,
      "worktree": "/abs/path/.iudex/worktrees/t1",
    },
  ],
}
```

`blocks` (the inverse dep map — which tickets each ticket unblocks) was added 2026-06-19 to back the ticket-detail panel's info section; it is computed in `status.go` alongside `blockedBy`, sorted by ticket number. Everything else the GUI needs is git plumbing or process supervision, kept out of the CLI on purpose.

---

## 3. Backend command surface (Rust)

Two modules, both registered in `lib.rs`'s `invoke_handler`. All git/file commands are read-only plumbing or scoped writes; none reimplement the state machine.

### `lib.rs` — workspace, config, git reads, review/merge

| Command                                                            | Purpose                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover_workspace(start)`                                        | Walk up for `.iudex/config.yml` (mirrors `workspace.Find`).                                                                                                                                     |
| `init_workspace(path)`                                             | `iudex init` a non-workspace folder.                                                                                                                                                            |
| `run_iudex(root, args)`                                            | **The write-path seam** — shells every mutation through the binary.                                                                                                                             |
| `iudex_status(root)`                                               | The read path — runs `status --json`, returns parsed JSON.                                                                                                                                      |
| `watch_workspace(root)`                                            | Start the `notify` doorbell on `.iudex/`; emits `events-changed`.                                                                                                                               |
| `read_config` / `write_config`                                     | `config.yml` fields; **write is surgical** — rewrites each known key's value line in place, preserving comments / blank lines / order.                                                          |
| `read_prompt` / `write_prompt`                                     | impl/review prompt templates (`.iudex/prompts/<name>.md`).                                                                                                                                      |
| `compose_ticket(root, title, body, deps)`                          | Allocate id via `next-ticket-id`, write `.iudex/queue/tN.md`, run `iudex queue [--deps]`; cleans up the orphan brief on failure.                                                                |
| `read_queue_brief` / `write_queue_brief`                           | Read/write a queued ticket's `.iudex/queue/<id>.md` (backs the ticket-detail panel's editable brief).                                                                                           |
| `worktree_task_docs(worktree)`                                     | `.task/{brief,log,review}.md` for an active+ ticket.                                                                                                                                            |
| `list_worktrees(root)`                                             | `git worktree list --porcelain`, drops the main worktree.                                                                                                                                       |
| `worktree_changes(worktree, mainBranch, threeDot?)`                | Changed files vs main; two-dot (default, shows uncommitted) or three-dot (what the ticket authored).                                                                                            |
| `worktree_file_diff(worktree, path, mainBranch, threeDot?)`        | Original/modified blobs + Monaco language for one file.                                                                                                                                         |
| `merge_preflight(root, worktree, mainBranch)`                      | Predicts whether `human-qa approve` would succeed: gates `on_main`, `clean` (+dirty files), `would_conflict` (+conflict files via `git merge-tree --write-tree`), `merge_in_progress`, `ready`. |
| `begin_resolution` / `abort_resolution`                            | Run / abort `git merge <main>` inside the worktree.                                                                                                                                             |
| `read_resolution(worktree)`                                        | Git's unmerged set (`--diff-filter=U`) joined to the agent's `.task/resolution.json` triage report.                                                                                             |
| `read_conflict_file` / `write_resolved_file` / `commit_resolution` | The merge-editor read/write/commit cycle (guarded — refuses to commit while any file is still unmerged).                                                                                        |
| `rail_status(root, mainBranch, worktrees)`                         | Per-card title + coarse merge badge for the Review rail, in one round-trip.                                                                                                                     |
| `brief_titles(worktrees)`                                          | First non-heading line of each worktree's brief (ticket titles).                                                                                                                                |
| `open_in_editor` / `reveal_in_finder` / `open_folder_with`         | OS escape hatches (editor, Finder reveal, app-picker "open with…").                                                                                                                             |

### `tmux.rs` — the unified session pool

| Command                                                                                        | Purpose                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tmux_available()`                                                                             | Is tmux on PATH? (views degrade gracefully if not).                                                                                                                                                                                                                                                                   |
| `list_sessions()`                                                                              | All pool sessions; ticket/role/start-time read from tmux user-options in one `list-sessions -F` call.                                                                                                                                                                                                                 |
| `create_shell(cwd?)`                                                                           | Ad-hoc shell session (optionally cwd'd into a worktree).                                                                                                                                                                                                                                                              |
| `spawn_agent(root, ticket, role)`                                                              | Runs `iudex spawn <id>` to capture the state-appropriate command, launches it in a new tmux session. **Agents accumulate** (each spawn = its own opaque `iudex-agent-<millis>-<seq>` session); `role` is GUI metadata. Sets `remain-on-exit on` so an exited agent's pane + exit code survive. Returns the `Session`. |
| `spawn_idea(root, skill, seed)`                                                                | Ticket-less `idea`-kind session running the configured agent at the workspace root, preloaded with a work-shaping skill.                                                                                                                                                                                              |
| `spawn_resolver(root, ticket, worktree)`                                                       | `resolve`-role agent in the worktree with a triage prompt (resolve-with-confidence-or-FLAG, write `resolution.json`, commit only if nothing flagged).                                                                                                                                                                 |
| `session_status(name)`                                                                         | Pane dead/alive + exit code (`#{pane_dead}` / `#{pane_dead_status}`).                                                                                                                                                                                                                                                 |
| `clear_finished()`                                                                             | Bulk-kill dead sessions.                                                                                                                                                                                                                                                                                              |
| `kill_session(name)`                                                                           | Prefix-guarded kill.                                                                                                                                                                                                                                                                                                  |
| `capture_pane(name, lines?)`                                                                   | Snapshot scrollback (used by status synthesis).                                                                                                                                                                                                                                                                       |
| `open_terminal` / `write_terminal` / `resize_terminal` / `close_terminal` / `next_terminal_id` | The PTY bridge: a `portable-pty` running `tmux attach`, streaming base64 `pty-{id}` events to xterm.js. **Close only detaches** — the session survives GUI restart.                                                                                                                                                   |

---

## 4. Frontend structure (React + TypeScript)

- **`App.tsx`** — workspace-open bar, 7-view top nav, view router, the doorbell subscription, and cross-view focus state (`focusSession`, `focusTicket`, `focusAgent`).
- **`types.ts`** — the `iudex status --json` contract (`Workspace`, `Ticket`) plus every backend struct mirror (`Worktree`, `FileChange`, `FileDiff`, `TaskDocs`, `RailCard`, `Resolution`, `ConflictFile`, `Preflight`, `Config`, `Session`).
- **`lib/`** — data hooks: `sessions` (tmux poll), `agents` (status synthesis + brief titles), `worktrees`, `review` (task docs + changes + preflight + resolution + rail status), `tickets` (ticket docs router), `skills` (the configurable idea-skill list), `monacoSetup` (local Monaco bootstrap — bundled, **not** CDN).
- **`components/`** — shared UI: `StateBadge` (ticket-state pill, exports `stateColor`), `ChangedFilesDiff` (files-list + diff panel), `Modal` (backdrop + box shell), `TicketDetail` (the floating ticket panel).
- **`views/`** — the 7 nav views plus the cross-cutting `DiffViewer`, `MergeEditor`, `XtermPane`.

### CSS architecture

No global stylesheet. **Co-located CSS Modules** (`X.module.scss` next to `X.tsx`, camelCase classes) + `styles/tokens.scss` (the dark palette as SCSS vars) + `styles/base.scss` (the only globals: cross-cutting utility classes `muted`/`error`/`ghost`/`esc`/`field`/etc. referenced by plain string + resets). Convention going forward: new view → new module; cross-cutting primitive → `base.scss`; reused UI → a shared `components/` entry.

---

## 5. The seven views (as built)

### Dashboard (default landing)

A light, glanceable router. Four triage piles derived from `status --json`: **ready to activate** (queued + ready, annotated with capacity vs `max_active`), **pending human review**, **in QA**, **failed**. Each pile jumps to its destination view; pending-review items open a specific ticket straight into Review. Two per-workspace (persisted) **opt-in automation toggles** sit on their piles. **Auto-activate** (ready pile): a drain loop activates ready tickets (re-reading status each step so deps + the `max_active` cap stay current) and spawns each ticket's impl agent — mirroring the manual activate path minus the view jump. **Auto-QA** (in-QA pile): auto-spawns a QA agent for each pending-qa ticket (the agent then runs `qa approve/reject` itself); spawning doesn't change ticket state, so it's guarded per pending-qa episode — one spawn per episode, the mark cleared when the ticket leaves pending-qa (so a reject→refinish re-QAs), skipping any ticket that already has a live QA session. Both stop short of the human-qa merge gate, which stays human.

### Terminal

Tabbed live tmux sessions via xterm.js over the PTY bridge. Stays mounted across view switches (visibility-toggled, not unmounted) so tabs and live PTYs survive. `+ shell` creates ad-hoc sessions; honors external focus requests (peek → focus, idea-launch → focus). Sessions persist across GUI restart.

### Tickets

Reactive table (id · state · qa-rejects · detail · actions) with a **state-aware action column** (Activate / Finish / Agent / QA agent / Retry) — every action shells through `iudex`; the doorbell refreshes the table, no manual re-read. Two front-of-funnel launchers: **New ticket** (thin compose form → `compose_ticket`) and **New idea** (pick a skill + seed → `spawn_idea`, opens in Terminal). **Clicking a row opens the floating ticket-detail panel** (see §6). Spawning any agent (from the row or the panel's actions menu) navigates to Agents with that new agent selected.

### Agents → master-detail cockpit

Left rail of agent cards (`tN · title · role · status`); right panel = the selected agent's cockpit with three tabs:

- **ticket** — a read-only brief view (`TicketBrief`).
- **console** — an **interactive** `XtermPane` (kept mounted across tab switches).
- **worktree** — the agent's two-dot diff via the shared `ChangedFilesDiff`.

Header `tN · role · title · status · ✕`; `✕` dismisses the panel only (agent keeps running), `kill agent` kills. **Clear-all-finished** is computed frontend-side from the synthesized status (superseded `done` + `crashed`), since claude idles rather than exits when done. Accepts a `focusAgent` prop so other views can deep-link to a specific agent.

**Synthesized status** (`lib/agents.ts`): ticket-state × process-liveness × output-activity → `working` / `idle` / `awaiting-finish` / `review-ready` / `crashed` / `done` / `gone`, role-aware (impl, qa, resolve each have a different "expected" terminal phase). Presented as a heuristic.

### Worktrees

Three-pane read-only inspection: rail keyed on **physical worktrees** (one entry even if >1 ticket maps to it; tickets are badge-tagged) | changed-files (A/M/D/U glyphs, `N files +X −Y` footer) | shared Monaco `DiffViewer`. Diff is **two-dot** vs main (deliberate — shows uncommitted agent progress). Escape hatches: open-in-editor, open-shell-here (spawns a worktree-cwd'd shell, focuses Terminal).

### Review → deep-review workspace (pending-human-qa)

Triage **rail** of cards (`tN · title · qa✓ · merge-badge`: ✓ clean / ⚠ conflicts / ◐ resolving) so clean merges can be sequenced ahead of conflicted ones. Header with escape hatches (Reveal in Finder, Open with…). Tab strip: **brief · implementation log · qa review · changes (N) · conflicts**.

- **changes** — three-dot diff (what the ticket authored) via files-list + Monaco.
- **conflicts** — a full in-GUI merge-readiness + resolution workspace. Phases: predicted-conflict (**Resolve with agent** / Resolve manually / Open shell / Re-check) → resolving (◐ banner, Watch / Stop, live unmerged list) → flagged (agent-flagged files with reasons → editable **MergeEditor** per file) → all-resolved (Commit resolution / Abort) → ready. A flagged conflict **blocks Approve**.

**Approve is preflighted and re-checked at click time** — the merge fires only when the preflight is green, so the most irreversible action in the app is guaranteed to succeed. Reject (with reason) via a modal.

### Settings

**General** + **Prompts** subtabs, each with its own Save. General writes `config.yml` (surgical, comments preserved) then parse-checks via `status --json` and refreshes the header; Prompts writes both impl/review templates (plain textareas — the read-only-Monaco invariant). Fixed subtab header; only the body scrolls.

---

## 6. Cross-cutting surfaces

### Ticket-detail panel (`components/TicketDetail.tsx`)

A **floating panel** that overlays the Tickets list from the right (~520px, `position: absolute` over a `position: relative` root, left box-shadow — it does not push the list aside). Layout:

- Header: `tN · state badge · ✕`.
- Title row: editable `<input>` when queued, plain text otherwise; plus a `⋮` **actions menu** (state-aware actions mirroring the table row + **Remove**; Remove closes the panel, all others leave it open and spawned-agent actions jump to Agents).
- **brief** section: editable textarea when queued, read-only `<pre>` once activated (the brief is the agent's spec — locked after activation; edits flow back via `write_queue_brief` behind an explicit **Save** in a footer shown only while queued).
- **info + agents** two-column grid: prerequisites / blocks / worktree / qa-rejects | live agent sessions for this ticket (role + status dot, click → jump to Agents).
- **log** section: `impl | qa` tabs, disabled until the ticket has a worktree.

The same `useTicketDocs(root, ticket)` hook backs both this panel and the Agents ticket tab: it routes to `worktree_task_docs` for active+ tickets and `read_queue_brief` for queued ones.

### DiffViewer (`views/DiffViewer.tsx`)

Shared lazy-loaded read-only Monaco diff (inline/split toggle, `title` + `actions` header slots). Monaco is bundled **locally** and code-split (~3.8MB chunk; main bundle stays ~580KB). Reused by Worktrees, Agents, and Review (via `ChangedFilesDiff`).

### MergeEditor (`views/MergeEditor.tsx`)

**The one bounded relaxation of the read-only-everywhere invariant.** A read-only reference DiffEditor (main ↔ ticket) over an editable result Editor seeded with the marker'd working file; hunk-aware Use-main / Use-this-ticket / Use-both quick-picks rewrite only the conflict block. Mark-resolved refuses while markers remain. Used only inside Review's conflicts tab.

---

## 7. Deviations & extensions vs the original PRD

| Original design                                     | As-built reality                                                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents = grid of `capture-pane` **peeks**           | Replaced with a **master-detail cockpit** (rail + interactive console + worktree diff + ticket tab).                                                                                                                            |
| Ticket detail = "side panel"                        | A **floating overlay** panel, 520px, that does not compress the list.                                                                                                                                                           |
| Diff via tmux read-only `-r` attach for peeks       | Peeks were dropped; the console is a single interactive PTY attach (avoids tmux's smallest-client resize war).                                                                                                                  |
| Merge conflicts **out of scope** (resolve manually) | **In-GUI agent-assisted resolution** + an editable merge editor were added — the agent triages (resolves trivial, flags ambiguous), a flagged conflict blocks Approve, the human-QA gate is unchanged.                          |
| Worktrees three-dot diff                            | Worktrees uses **two-dot** (shows uncommitted edits); Review uses **three-dot** (what would merge).                                                                                                                             |
| Single `agent_command`                              | Replaced by a **pool** (`agent_commands` + per-role `agent_roles`: impl/qa/resolve/idea). The GUI reads it via `iudex config --json` and resolves a role via `iudex agent-command <role>` — no Rust-side parsing or resolution. |
| Read path possibly needs `export --json` too        | The read path is `status --json` + `config --json` + `agent-command` (all CLI-sourced); `export --json` never required. `blocks` field added to `status --json` for the ticket panel.                                           |

**Accepted-as-is (deliberate):** agent spawning has zero guards (a stray double-click fires real billable `pi`); synthesized status can mislead (it's a heuristic); dead sessions accumulate (manual clear-finished); binary/huge files render blank in the diff.

---

## 8. What remains

Lighter feature backlog (all 7 nav views have real implementations — `Stub.tsx` is dead code):

1. **Dependency-DAG toggle** inside Tickets (a mode, not a nav slot).
2. **Recent-projects launcher** + smoother multi-window scoping (the tmux pool is currently global; per-workspace `@iudex_root` tagging + filtering is the planned fix).
3. **Multi-workspace tmux scoping** — stamp `@iudex_root` on spawn, filter `list_sessions`/`clear_finished` by root.

Hardening backlog (from the end-of-session grills): extract pure `apply_config` / `parse_conflict_files` for unit tests + temp-repo git fixtures; a GUI-side Vitest decode check defending the `status --json` ↔ `types.ts` contract; turn on `git rerere`; longer-term, surface conflicts early by auto-merging main into other pending worktrees on approve.

---

## 9. Build & run

```bash
# Frontend + Rust dev app
cd gui
export PATH="$HOME/.cargo/bin:$PATH"
IUDEX_BIN=/path/to/iudex pnpm tauri dev   # GUI resolves the binary via $IUDEX_BIN, else PATH

# Checks
pnpm build                                 # tsc + vite
cargo check --manifest-path src-tauri/Cargo.toml
```

**Stack:** Tauri 2 · React 19 + TypeScript 5.8 · Vite 7 · xterm.js 6 · Monaco 0.55 (bundled) · sass. **Prereqs:** Rust/cargo, Node + pnpm, tmux (for the session pool — views degrade gracefully without it), Xcode CLT on macOS.

**The boundary, restated:** the GUI may _act_ (write via `iudex`) and _observe_ (read via `status --json`, watch `events.jsonl`, supervise tmux), but the CLI alone _decides_. Every authoritative state transition is a real `iudex` command.
