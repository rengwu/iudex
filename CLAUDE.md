# iudex — Agent Handoff Document

## What this is

iudex is a Go CLI tool that orchestrates AI coding agents (Claude Code, Aider, etc.) across git worktrees. It drives every ticket through a **queue → implement → QA → human-review → merge** pipeline, keeping all state file-based and git-native with no runtime dependency beyond `git`.

**There is no running instance.** No daemon, no background loop, no ticks, no TUI, no stall detection. The "orchestrator" is just a set of rules: every state transition is an explicit command a human (or an agent acting on a ticket) runs. iudex prints ready-to-paste agent spawn commands but never launches an agent itself.

> This is a ground-up rewrite. An earlier version was a daemon + Bubble Tea TUI with a polling goroutine; that design is **superseded**. If you find references to an orchestrator goroutine, ticks, `max_agents`, priority, or `rejected`/`human-manual` states, they are from the old design.

The design is specified in `docs/2026-06-14-v1-PRD.md` (the deprecated v0 design is kept at `docs/2026-06-12-v0-PRD.md`).

---

## Build

```bash
go build -o iudex .

# Cross-compile (e.g. Raspberry Pi)
GOOS=linux GOARCH=arm go build -o iudex-arm .
```

Requires Go 1.22+. Dependencies are just `github.com/spf13/cobra` and `gopkg.in/yaml.v3` (+ their transitive deps). `vendor/` is gitignored; a fresh clone fetches modules normally.

> `build.sh --gopath` (offline apt build) is **stale** — it still references the removed `bubbletea`/`lipgloss` packages and needs updating before use.

---

## Mental model

- **`events.jsonl` is the single source of truth.** Ticket state, dependencies, and the QA-reject counter are all _derived_ by replaying it. Nothing is stored anywhere else.
- **Nothing advances on its own.** A ticket only changes state when someone runs a command.
- **In-place workspace.** iudex runs inside your project, like `git`. Everything it owns lives under a single gitignored `.iudex/` directory; the existing repo is the canonical `main` worktree.
- **iudex is agent-agnostic.** It computes spawn commands from config + prompt templates and prints them; the human launches the agent.

---

## Workspace layout (what `iudex init` creates)

```
<your-project>/                 # existing git repo = canonical "main" worktree
├── .iudex/                      # all iudex state (gitignored as a whole)
│   ├── config.yml               # main_branch, max_active, qa_reject_limit, agent_command,
│   │                            #   merge_strategy, merge_message_template, branch_prefix
│   ├── prompts/
│   │   ├── impl.md              # injected into impl spawn commands
│   │   └── review.md            # injected into QA spawn commands
│   ├── skills/                  # bundled work-shaping skills (one <name>/SKILL.md each)
│   ├── queue/                   # author tickets here: t<N>.md
│   ├── archive/                 # archive/t<N>/ per done/removed ticket
│   ├── events.jsonl             # append-only source of truth
│   └── worktrees/
│       └── t<N>/                # one git worktree per active ticket (branch <branch_prefix>t<N>)
│           └── .task/           # brief.md, log.md, review.md (ignored via the repo's shared exclude)
├── AGENTS.md                    # TRACKED; init appends a marked iudex section indexing the skills
├── .context/                    # TRACKED project docs (created lazily by the skills)
│   ├── glossary.md              #   domain glossary (every top-level *.md is read as glossary)
│   ├── adr/                     #   architectural decision records, NNNN-slug.md
│   └── prd/                     #   PRDs from to-prd (subfolder so they aren't read as glossary)
└── …                            # your real project files, on main_branch
```

`.task/` is kept out of git via the repository's shared exclude (`$GIT_DIR/info/exclude`), so it never pollutes a tracked `.gitignore` and never leaks into a merge.

### Work-shaping skills (the front of the funnel)

Everything _before_ `iudex queue` — turning a raw idea into robust, sliced, dependency-ordered tickets — is handled by bundled skills, not by the CLI. They are embedded in the binary, scaffolded to `.iudex/skills/` on `init`, and indexed in a tracked root `AGENTS.md` so the user's agent loads the relevant `SKILL.md` on demand (no cat-injection). The funnel:

```
grill-me / grill-with-docs → prototype → to-prd → to-issues → iudex queue
```

`to-issues` is the seam to the CLI: it slices a plan/PRD into `t<N>.md` briefs and registers them with `iudex queue tN --deps …` (each slice's blockers become iudex deps; deps live only in the queue event, never in the markdown). The coupling is one-directional — skills call the CLI; the CLI knows nothing about the skills.

`.context/` is **tracked** (unlike the gitignored `.iudex/`): committing the glossary, ADRs, and PRDs is what makes them visible inside ticket worktrees, so impl/QA agents share the same domain language. The bundled set is grill-me, grill-with-docs, prototype, to-prd, to-issues, improve-codebase-architecture.

---

## Ticket lifecycle

```
iudex next-ticket-id            # prints N (highest ever + 1); author .iudex/queue/tN.md yourself
iudex queue tN --deps t1,t2     # register tN + its blocking deps in the event log

iudex activate tN               # queued → active: deps must all be done, under max_active;
                                #   creates worktree off main_branch, moves the brief into
                                #   .task/brief.md, seeds .task/log.md, prints the impl spawn cmd

# impl agent (or a human) works in the worktree, commits, then:
iudex finish                    # active → pending-qa (ticket inferred from the worktree cwd);
                                #   auto-commits a checkpoint if dirty; prints the QA spawn cmd

# QA agent reviews, writes .task/review.md, then:
iudex qa approve                # pending-qa → pending-human-qa
iudex qa reject                 # pending-qa → active (or → failed at qa_reject_limit)

# human:
iudex review tN                 # print brief, log, diff vs main, review, state, next actions
iudex human-qa approve tN       # merge to main, archive, remove worktree → done
iudex human-qa reject tN --reason "…"   # → active; reason appended to .task/review.md
iudex remove tN                 # abandon from any non-terminal state → removed

iudex retry tN                  # failed → active, reset the QA-reject counter
```

### State machine

```
(none) --queue--------> queued
queued --activate-----> active            [all deps done, under max_active]
active --finish-------> pending-qa         [auto-commits if dirty]
pending-qa --qa approve----------> pending-human-qa
pending-qa --qa reject-----------> active  [count < qa_reject_limit]
pending-qa --qa reject-----------> failed  [count == qa_reject_limit]
pending-human-qa --human-qa approve--> done    [merge + archive + remove worktree]
pending-human-qa --human-qa reject---> active  [--reason appended to review.md]
failed --retry-------------------> active  [counter reset]
<any non-terminal> --remove------> removed [archive + remove worktree if present]
```

**Seven states:** `queued`, `active`, `pending-qa`, `pending-human-qa`, `done`, `failed`, `removed`. Terminal: `done`, `removed`.

**QA-reject counter:** increments on `qa reject`, resets on `retry`; `human-qa reject` never counts or resets it. `qa_reject_limit <= 0` means unlimited.

---

## CLI commands (12)

| Command                               | Description                                                                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iudex init`                          | Scaffold the current directory into a workspace (git init + initial commit only if no history; records the current branch as `main_branch`; gitignores `.iudex/`)                                                                   |
| `iudex next-ticket-id`                | Print the next ticket id `N` (highest ever + 1) and nothing else                                                                                                                                                                    |
| `iudex queue <id> [--deps <ids>]`     | Register a queued ticket and its deps; rejects reused ids and deps that aren't already registered (or are removed/failed)                                                                                                           |
| `iudex activate <id>`                 | queued → active: create worktree + `.task/`, print impl spawn command                                                                                                                                                               |
| `iudex finish [id]`                   | active → pending-qa; auto-commit if dirty; print QA spawn command (id inferred from cwd)                                                                                                                                            |
| `iudex spawn [id]`                    | Print the spawn command for the ticket's current state (impl/QA); never launches                                                                                                                                                    |
| `iudex qa approve\|reject [id]`       | Agent QA gate (id inferred from cwd)                                                                                                                                                                                                |
| `iudex human-qa approve\|reject <id>` | Human gate: approve merges/archives/removes; reject (`--reason`) returns to active                                                                                                                                                  |
| `iudex retry <id>`                    | failed → active, reset the QA-reject counter                                                                                                                                                                                        |
| `iudex remove <id>`                   | Abandon from any non-terminal state → removed                                                                                                                                                                                       |
| `iudex review <id>`                   | Read-only: print brief, log, diff, review, state, next actions                                                                                                                                                                      |
| `iudex status [--all] [--json]`       | Tickets grouped by state; queued annotated ready/blocked; done/removed hidden unless `--all`. `--json` emits a machine-readable object (`{mainBranch,maxActive,qaRejectLimit,tickets[]}`, always all tickets) — the GUI's read path |

Worktree-scoped commands (`finish`, `qa`, `spawn`) infer the ticket from the current directory when run inside a worktree; an explicit id always overrides.

---

## Source layout

```
iudex/
├── main.go                    # thin entrypoint; //go:embed templates → cmd.Execute(fs)
├── main_test.go               # CLI-seam tests (build binary, hermetic git config, drive the pipeline)
├── go.mod                     # module: iudex; deps: cobra, yaml.v3
├── templates/dot_iudex/       # embedded scaffold (config.yml, prompts/) → .iudex/ on init
├── gui/                       # native desktop client (Tauri) — a separate in-repo project; see "GUI client" below
└── internal/
    ├── workspace/             # discovery (walk up for .iudex/config.yml), Config, path helpers, TicketFromCwd
    ├── events/                # append-only events.jsonl: Event, Append (O_APPEND), ReadAll
    ├── ticket/                # state machine: States/Triggers, Status, Derive (replay), DepsReady, MaxID, ParseID
    ├── git/                   # all git ops via exec.Command
    ├── archive/               # copy .task/ + diff.patch + meta.json into archive/<id>/
    └── cmd/                    # cobra command tree, one file per command; common.go = shared helpers
```

### Internal packages

- **`workspace`** — `Find` walks up from cwd for `.iudex/config.yml` (works from inside a worktree, like git finds `.git`). `Config`/`LoadConfig`, path helpers, and `TicketFromCwd` (reverse-maps a cwd to its ticket).
- **`events`** — `Event{ID,Ticket,From,To,TS,Trigger,Deps,Reason}`. `Append` fills a UUID + RFC3339 timestamp and writes one JSON line with `O_APPEND` (concurrency-safe). `ReadAll` returns all events, skipping malformed lines.
- **`ticket`** — `State`/`Trigger` constants, `Status{Ticket,State,Deps,QARejects}`. `Derive` replays events into per-ticket status (state = last `To`; deps from the queue event; counter increments on `qa-reject`, resets on `retry`). Plus `DepsReady`, `MaxID`, `ParseID`/`FormatID`, `IsTerminal`, `HasWorktree`.
- **`git`** — `exec.Command` wrappers: `IsRepo`, `Init`, `CurrentBranch`, `HasCommits`, `CommitAll`, `CreateWorktree`, `RemoveWorktree`, `IsClean`, `WIPCommit`, `Diff` (three-dot vs base), `Merge` (no-ff/squash, aborts + restores on failure), `EnsureExclude` (writes `.task/` to the shared exclude).
- **`archive`** — `Archive` copies `brief.md`/`log.md`/`review.md` from `.task/`, writes `diff.patch` and `meta.json` (outcome, timestamps, merge commit, qa-reject count, full event history) into `archive/<id>/`.
- **`cmd`** — cobra commands, one file per command. `common.go`: `loadContext` (workspace + config + events + derived statuses), `resolveTicket` (explicit or cwd-inferred), `spawnCommand`.

---

## Key design decisions

| Decision                                        | Rationale                                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `events.jsonl` as sole source of truth          | Concurrent-safe POSIX `O_APPEND`; status is a pure projection via replay                                                                      |
| Deps recorded in the queue event, not markdown  | No file-vs-state drift; deps must be pre-registered → dependency graph is a DAG by construction (no cycle detection needed)                   |
| In-place workspace under a gitignored `.iudex/` | Run iudex inside your project; nothing pollutes project history                                                                               |
| Merge happens in the repo root                  | git forbids `main` checked out in two worktrees, so `human-qa approve` merges at the root and refuses unless it is on `main_branch` and clean |
| Mark `done` immediately after the merge         | The merge is the irreversible step; archive + worktree removal are best-effort cleanup whose failure is reported but never blocks             |
| `.task/` ignored via the shared exclude         | Keeps it out of any tracked `.gitignore` and out of the merge; the worktree stays pristine                                                    |
| iudex prints spawn commands, never execs        | Stays agent-agnostic; the human launches the agent                                                                                            |
| cwd-based ticket inference                      | An agent inside a worktree runs `iudex finish`/`qa …` without knowing its ticket id                                                           |
| All git via `exec.Command`                      | No libgit2; works wherever `git` is installed                                                                                                 |
| `//go:embed templates` (no `all:`)              | Bundles the scaffold while excluding dot-prefixed junk (e.g. `.DS_Store`)                                                                     |

---

## Configuration (`.iudex/config.yml`)

| Field                    | Meaning                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `main_branch`            | Canonical merge target (set to the repo's current branch at init)   |
| `max_active`             | Cap on tickets in the `active` state (`0` = unlimited)              |
| `qa_reject_limit`        | QA rejections before a ticket becomes `failed` (`<= 0` = unlimited) |
| `agent_command`          | Binary used to build spawn commands (e.g. `claude` or `pi`)         |
| `merge_strategy`         | `no-ff` (default) or `squash`                                       |
| `merge_message_template` | Merge commit message; `{{.Ticket}}` is substituted                  |
| `branch_prefix`          | Per-ticket branch prefix (e.g. `work/`)                             |

---

## Testing

```bash
go test ./...
```

- `internal/ticket`, `internal/events` — fast unit tests (replay rules, the qa-reject counter, deps, append/read).
- `main_test.go` — CLI-seam tests: builds the binary once in `TestMain` with a **hermetic git config** (pinned `init.defaultBranch` + identity via `GIT_CONFIG_GLOBAL`/`GIT_AUTHOR_*`), then drives the pipeline in temp repos and asserts state after each command. Covers the full happy path to `done` (merge, archive, worktree removal), dep-blocking, `max_active`, the qa-reject ladder to `failed`, `retry`, `human-qa reject` feedback, the dirty/off-main approve guards, and `remove`.

---

## GUI client (`gui/`)

A native **Tauri desktop client** that drives this CLI the way a git client drives `git`. It is a **separate in-repo project** (its own build: `cd gui && pnpm tauri dev`), not part of the Go binary. See `gui/README.md` for the full description; the design is `.context/prd/gui-client.md`.

**The core invariant:** the GUI holds **no authoritative state**. It **reads** derived truth via `iudex status --json`, **writes** by shelling every mutation through the `iudex` binary, and watches `.iudex/events.jsonl` as a _doorbell_ (re-reads on any change). It never reimplements `Derive` (the state machine stays single-sourced in the CLI), so GUI and CLI cannot diverge. It does own the one thing the CLI won't — **agent process supervision** — via a tmux session pool.

- **The one upstream change it required** is `iudex status --json` (already landed). Git reads it needs (worktree diffs, the merge-preflight via `git merge-tree`) shell `git -C <dir>` directly from the GUI's Rust backend — plain plumbing, not state-machine logic, so they deliberately stay out of the CLI.
- **Seven views:** Dashboard, Terminal, Tickets, Agents, Worktrees, Review (preflighted approve & merge), Settings.
- **Status:** built on branch `feat/gui-read-path` (off `main`, not yet merged). The GUI evolves independently; treat `gui/` changes as scoped to that project.

---

## Not yet implemented / known gaps

- **Automation** — auto-activation of ready tickets, any watch loop, or concurrency policy beyond the manual `max_active` cap. v1 is deliberately command-driven; automation is future work.
- **Merge-conflict tooling** — a conflicting `human-qa approve` aborts and is resolved manually; iudex does not assist.
- **Direct unit tests** for `workspace`, `git`, and `archive` (currently exercised only transitively via the CLI seam).
- **README** may lag the implementation.

---

## Non-goals (v1)

- No background process, daemon, ticks, heartbeat, or stall detection.
- No TUI — `iudex status` is a one-shot print.
- No automatic merging — a human runs `iudex human-qa approve`.
- No remote/multi-machine coordination; iudex state is local-only.
- No launching of agent processes — iudex only prints spawn commands.
