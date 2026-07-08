<!-- <p align="center">
  <img src="./docs/assets/logo.png" alt="iudex logo" width="240" />
</p> -->

<h1 align="center">iudex</h1>

<p align="center">
  <strong>Describe what to build. Review what ships. Let the agents handle the rest.</strong>
</p>

<p align="center">
  A desktop app for running AI coding agents like an engineering team — in parallel, under review, on top of plain git.
</p>

<p align="center">
  <!-- TODO: replace badges once the repo is public and a release is cut -->
  <a href="https://github.com/rengwu/iudex/releases"><img src="https://img.shields.io/github/v/release/rengwu/iudex?display_name=tag" alt="Release" /></a>
  <a href="https://github.com/rengwu/iudex/stargazers"><img src="https://img.shields.io/github/stars/rengwu/iudex?style=flat" alt="Stars" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey" alt="Platforms" />
  <img src="https://img.shields.io/badge/built%20with-Tauri%20%2B%20Go-blue" alt="Built with Tauri + Go" />
  <!-- TODO: add a LICENSE file, then a license badge -->
</p>

<p align="center">
  <img src="./docs/assets/iudex-dashboard.png" alt="iudex — the pipeline at a glance" width="820" />
</p>

---

## What is iudex?

iudex runs AI coding agents like an engineering team: work enters as tickets, each agent gets an isolated git worktree, and nothing reaches `main` without passing QA and your sign-off.

One agent in one terminal doesn't scale. iudex runs many in parallel, each under review, with a full git paper trail — the layer around the agents, not another agent.

## Describe, then review

Building starts as conversation. You shape requirements into discrete tickets; agents work them in parallel, each change passing a QA review before it surfaces.

You describe at the start and review at the end. iudex owns the middle — tickets, worktrees, QA, coordination.

## Why iudex?

One agent is easy. Several in parallel gets messy — orphaned branches, unclear review state, a `main` you stop trusting. iudex imposes structure, and it reads differently depending on where you sit:

- **Engineers** — parallel agents in isolated worktrees, a terminal into any live session, diffs before anything lands, full git provenance. No lock-in; it's git all the way down.
- **Owners & managers** — requirements and progress as tickets moving through a pipeline. See what's blocked on you; gate what ships without reading every line.

## Features

**A seven-view cockpit:**

| View          | What it's for                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| **Dashboard** | Next-action hero, the pipeline as clickable columns, an idea launcher, and a live activity feed.               |
| **Terminal**  | Tabbed, interactive agent sessions; PTYs survive view switches.                                                |
| **Tickets**   | Every ticket in a reactive table with state-aware actions and front-of-funnel launchers.                       |
| **Agents**    | Live `capture-pane` peeks per agent with synthesized status — working, idle, awaiting hand-off, crashed, done. |
| **Worktrees** | Per-worktree diff inspection with escape hatches into your editor or a shell.                                  |
| **Review**    | The human gate: brief, log, QA notes, diff, and a conflict-predicting approve & merge.                         |
| **Settings**  | Agent commands, prompts, per-workspace config.                                                                 |

Beyond the views:

- **Parallel by design** — one git worktree and branch per agent; no collisions.
- **A real review gate** — a separate QA agent reviews before you do, and the final merge is always yours, preflighted against conflicts via `git merge-tree`.
- **Opt-in automation** — auto-activate, auto-QA, auto-retire, auto-resolve, armed individually and session-only, so a launch never spends tokens on its own. Sequential mode caps you at one ticket in flight.
- **Agent-agnostic** — Claude Code, Aider, anything you launch from a command line.
- **Git-native & event-sourced** — no daemon, no database. State is a projection of an append-only log; every worktree is a real branch. Delete the app and your history is still just git.

## Install

### Desktop app (recommended)

Grab the latest build from [**Releases**](https://github.com/johngohrw/iudex/releases):

| Platform              | Asset       |
| --------------------- | ----------- |
| macOS (Apple Silicon) | `.dmg`      |
| Linux (x86_64)        | `.AppImage` |

The app bundles the CLI as a sidecar — no separate setup. Requires [tmux](https://github.com/tmux/tmux) ≥ 3.2 for the terminal and agent sessions. Building from source: see [`gui/README.md`](./gui/README.md).

### CLI only

A standalone Go binary, no runtime dependency beyond `git`:

```bash
go build -o iudex .
# put it on your PATH and use it like git, inside any project
```

## Quick start

Point the app at any git repo and click **Open** — with no workspace, it offers to `init` one in place. The Dashboard takes it from there: compose a ticket, activate it, and iudex spawns an agent and tracks it to review.

The same pipeline from the terminal:

```bash
cd ~/code/my-project
iudex init                          # scaffold .iudex/ in place (gitignored)

# author a ticket, then register it
vim .iudex/queue/t$(iudex next-ticket-id).md
iudex queue t1                      # or: iudex queue t2 --deps t1

iudex activate t1                   # create the worktree, print the impl spawn command
iudex finish                        # (from inside the worktree) hand off to QA
iudex qa approve                    # or: iudex qa reject → back to active

iudex review t1                     # brief, log, diff, QA review, next actions
iudex human-qa approve t1           # merge to main, archive, remove the worktree
```

`iudex status` shows the board any time.

## The CLI

The GUI and CLI are two front-ends to one engine — agents inside a worktree call these directly.

| Command                               | Description                                                           |
| ------------------------------------- | --------------------------------------------------------------------- |
| `iudex init`                          | Scaffold the current directory into a workspace                       |
| `iudex next-ticket-id`                | Print the next ticket id                                              |
| `iudex queue <id> [--deps <ids>]`     | Register a ticket and its dependencies                                |
| `iudex activate <id>`                 | Create the worktree, print the impl spawn command                     |
| `iudex finish [id]`                   | Hand off to QA (auto-commits if dirty); id inferred from the worktree |
| `iudex spawn [id]`                    | Reprint the spawn command for a ticket's current state                |
| `iudex qa approve\|reject [id]`       | Agent QA decision                                                     |
| `iudex human-qa approve\|reject <id>` | Merge, or send back for revision (`--reason`)                         |
| `iudex retry <id>`                    | Reset a failed ticket for another attempt                             |
| `iudex remove <id>`                   | Abandon a ticket                                                      |
| `iudex review <id>`                   | Print brief, log, diff, QA review, state, next actions                |
| `iudex status [--all] [--json]`       | Tickets by state (`--json` = machine-readable read path)              |
| `iudex config [--json]`               | Print the workspace config                                            |
| `iudex agent-command <role>`          | Print the agent command resolved for a role                           |

`finish`, `qa`, and `spawn` infer the ticket from the current worktree.

**Dependencies** are declared at registration; a ticket can't activate until each is `done`:

```bash
iudex queue t2 --deps t1,t3
```

Deps must already be registered, which keeps the graph acyclic by construction. `iudex status` marks each queued ticket ready or blocked.

## Shaping the work

The pipeline starts at `iudex queue`. Turning a raw idea into sliced, dependency-ordered tickets is handled by bundled skills that `init` scaffolds into `.iudex/skills/` and indexes in a tracked `AGENTS.md`, loaded on demand:

- **grill-me / grill-with-docs** — interrogate a plan until it holds up; the docs variant maintains a glossary and ADRs.
- **prototype** — throwaway code to validate a design first.
- **to-prd** — synthesize the discussion into a PRD.
- **to-issues** — slice a plan into tickets and register them with their deps.
- **improve-codebase-architecture** — surface refactors that feed back into the funnel.

Project docs live in a tracked `.context/` (glossary, ADRs, PRDs) so they travel into every worktree — impl and QA agents share the same language.

## Configuration

Workspace config is `.iudex/config.yml`; the machine-level agent pool is `~/.iudex/config.yml`. Both are editable from **Settings**.

| Field                                       | Meaning                                             |
| ------------------------------------------- | --------------------------------------------------- |
| `main_branch`                               | Merge target (your repo's branch at init)           |
| `max_active`                                | Cap on active tickets (`0` = unlimited)             |
| `qa_reject_limit`                           | QA rejections before a ticket is `failed`           |
| `merge_strategy`                            | `no-ff` or `squash`                                 |
| `branch_prefix`                             | Per-ticket branch prefix (e.g. `work/`)             |
| `agent_commands` / `agent_roles` _(global)_ | Named agent commands and the role → command mapping |

`.iudex/prompts/impl.md` and `review.md` hold the instructions baked into spawn commands.

## Under the hood

- **One source of truth.** State, dependencies, and the QA-reject counter are derived by replaying an append-only `events.jsonl` — concurrency-safe, no separate database to drift.
- **In-place workspace.** iudex runs inside your project, like `git`. Everything it owns lives under a gitignored `.iudex/`; your repo stays the canonical `main`, and every ticket worktree is a real branch.
- **The GUI holds no authoritative state.** It reads via `iudex status --json`, writes by shelling the CLI, and watches `events.jsonl` as a doorbell — it can't diverge from the engine. It owns the one thing the CLI won't: agent process supervision, via a tmux pool.
- **All git via `exec.Command`** — no libgit2; works wherever `git` is installed.

Built with [Tauri](https://tauri.app) (Rust + React), [xterm.js](https://xtermjs.org), and [Monaco](https://microsoft.github.io/monaco-editor/); a small Go CLI (`cobra` + `yaml.v3`) underneath.

## Contributing

Issues and PRs welcome. The desktop client is a separate in-repo project under [`gui/`](./gui) with its own build; the CLI is the Go module at the root. Run `go test ./...`.

<!-- TODO: add a LICENSE file and a License section before going public -->
