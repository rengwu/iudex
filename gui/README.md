# iudex GUI

A native desktop client for [iudex](../README.md) — a cockpit for driving the
`queue → implement → QA → human-review → merge` pipeline. It drives the CLI the
way a git client drives `git`: it **holds no authoritative state**, **reads**
derived truth via `iudex status --json`, **writes** by shelling out to `iudex`,
and treats `.iudex/events.jsonl` as a doorbell (on any change it re-reads). It is
also the human's hands — it owns agent process lifecycles via a tmux pool, which
the CLI deliberately never does.

> The design is specified in an internal PRD (hardened through a `grill-me`
> session → 13 decisions).

## Stack

- **Tauri 2** — Rust backend (`src-tauri/`), web frontend (`src/`).
- **React + TypeScript + Vite**.
- **xterm.js** + `portable-pty` — interactive terminals over a tmux session pool.
- **Monaco** (read-only) — the shared diff viewer (Worktrees + Review). Bundled
  locally and lazy-loaded (no CDN; works offline / under Tauri's CSP).

## Prerequisites

- **Rust** (`cargo`) — Tauri's backend toolchain.
- **Node + pnpm** — the frontend uses pnpm.
- **Go 1.22+** — the iudex CLI is compiled into the bundle as a sidecar
  (`scripts/build-cli.mjs`, run automatically before dev/build).
- **tmux ≥ 3.2** — backs the terminal/agent session pool (the Terminal and
  Agents views degrade to a hint without it).

## Run

```bash
cd gui
pnpm install
pnpm tauri dev   # the first cargo build is slow, then cached
```

The window opens with a path field — enter any iudex workspace and click **Open**
(opening a folder with no workspace offers to `iudex init` it).

## The bundled CLI (packaging)

The app ships with the iudex CLI baked in, so a packaged install needs no
separate `iudex` setup. `scripts/build-cli.mjs` compiles the Go CLI from the
repo root into `src-tauri/binaries/iudex-cli-<triple>` (Tauri `externalBin`),
stamping `iudex --version` from `tauri.conf.json` — the single version source
for a release. `iudex-cli` because the GUI executable in the same bundle dir is
itself named `iudex`.

Binary resolution, highest tier wins: the saved path from Settings →
`$IUDEX_BIN` → the bundled CLI → its managed copy → `iudex` on PATH. The
bundled tiers sit above PATH so a packaged GUI always runs the CLI it was
released with; an explicit override still wins.

At startup the app refreshes a **managed copy** at `~/.iudex/bin/iudex` (a
copy, not a symlink — unsigned bundles get path-randomized by Gatekeeper
translocation and AppImages mount read-only). That copy is what lets things
*outside* the GUI process run `iudex`:

- **tmux sessions** get `~/.iudex/bin` prepended to `PATH` (agents run
  `iudex finish` / `iudex qa` themselves) — but only while the GUI resolves to
  the bundled CLI, so a user's own binary is never shadowed;
- **Settings → CLI → Install CLI command** symlinks
  `~/.local/bin/iudex → ~/.iudex/bin/iudex` for the user's own terminal.

Release builds: `scripts/release-macos.sh` for a local unsigned macOS bundle;
`.github/workflows/release.yml` (tag-triggered) builds macOS arm64 + Linux
x86_64 bundles plus standalone CLI binaries into a draft GitHub release.

## The seven views

| View | What it does |
|------|--------------|
| **Dashboard** | Home + default landing. NOW hero (single-sourced `workspaceNextAction` ranking, problems-first), the pipeline as clickable columns, inline idea launcher, roomy automation controls, and an events.jsonl activity feed. Navigational — target views own the actions. |
| **Terminal** | Tabbed live tmux sessions (interactive). Stays mounted across view switches so PTYs survive. |
| **Tickets** | Reactive table + a state-aware action column (activate/finish/agent/retry) and the front-of-funnel launchers (compose a ticket, shape an idea via a skill agent). |
| **Agents** | Grid of read-only `capture-pane` peeks into each live agent, with a synthesized status (working / idle / awaiting-finish / crashed / done). Click a peek → focus its terminal. |
| **Worktrees** | Read-only, editor-style inspection keyed on physical worktrees: changed files (two-dot vs main, incl. uncommitted) + Monaco diff + escape hatches (open in editor / shell). |
| **Review** | Deep-review workspace for `pending-human-qa`: brief / log / QA-review tabs + three-dot diff, with a **preflighted** approve & merge (predicts conflicts via `git merge-tree`; one-click Begin-resolution) and reject-with-reason. |
| **Settings** | General / Prompts subtabs: edit `config.yml` fields and the impl/review prompt templates (surgical writes preserve comments). |

The sidebar transport drives the opt-in automation engine (Auto-Activate —
which also respawns impl agents for tickets QA/human-rejected back to `active`
— Auto-QA, Auto-Retire, and Auto-Resolve — pre-resolves merge conflicts on
the first review-ready ticket, one at a time, parking on flagged files for
the human; armed individually, never by ▶; all session-only so an app launch
never silently spends tokens) plus **Sequential**: a persisted per-workspace
policy
(`gui_sequential` in `.iudex/config.yml`) that allows at most one ticket in
flight and hard-blocks GUI activation past it, engine on or off. (Design
detailed in an internal PRD.)

## Architecture

```
React UI ──reads──> iudex status --json ──┐
   │                                       ├─ the GUI never reimplements Derive;
   ├──writes──> iudex <subcommand>         │  the state machine stays single-
   │                                       │  sourced in the CLI.
   └──supervises──> tmux pool (agents/shells, via portable-pty + capture-pane)

.iudex/events.jsonl ──(notify watcher)──> "events-changed" doorbell ──> re-read
```

- **Backend** (`src-tauri/src/`): `lib.rs` holds the read/write seam (workspace
  discovery, `iudex_status`, `run_iudex`, workspace `init`, config + agent-command
  reads via `iudex config --json` / `iudex agent-command`, prompt + git read
  commands, the events watcher); `tmux.rs` holds the session pool + PTY bridge.
  Config parsing and role→command resolution are **not** reimplemented here — they
  shell the CLI, so the schema/migration/resolution rule stay single-sourced.
  Git reads (worktree diffs, merge-preflight) shell `git -C <dir>` directly —
  plain plumbing, not state-machine logic, so they stay out of the CLI.
- **Frontend** (`src/`): `App.tsx` (a thin shell — workspace bar + nav + view
  router + chrome) over focused hooks in `lib/` (`api.ts` = the typed wrapper for
  **every** Tauri command, `workspace`/`automation`/`sessions`/`iudexCheck`/
  `viewKeepAlive` + the per-view poll/derive hooks); `views/` (one per view + the
  shared `DiffViewer`); `types.ts` (mirrors the `status --json`/`config --json`
  contracts).
- **Invariant:** every backend call goes through `lib/api.ts`; writes go through
  `iudex`, reads through `iudex … --json`, `events.jsonl` is a doorbell — so the
  GUI and CLI can never diverge.
