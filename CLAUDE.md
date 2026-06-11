# llm-flow-go — Agent Handoff Document

## What this is

llm-flow-go is a Go CLI tool that orchestrates parallel AI coding agents (Claude Code, Aider, etc.) across git worktrees. It manages a queue → implement → QA → human review → merge pipeline, keeping every stage file-based and git-native with no runtime dependencies beyond `git`.

It is a Go rewrite of a Python prototype. The workspace file layout, ticket pipeline, and all design decisions are **locked in** — do not change them. Add features only if explicitly instructed.

---

## Build

```bash
go mod tidy && go build -o llm-flow .

# Cross-compile for Raspberry Pi 3B
GOOS=linux GOARCH=arm go build -o llm-flow-arm .

# Offline / restricted build
./build.sh --gopath
```

Requires Go 1.22+. All dependencies are vendored in `vendor/`.

---

## Project layout

```
llm-flow-go/
├── main.go                    # Cobra CLI — all 10 commands
├── go.mod                     # module: llm-flow
├── vendor/                    # vendored deps (bubbletea, lipgloss, cobra, yaml.v3)
├── templates/                 # embedded via //go:embed all:templates
│   ├── dot_llmflow/           # → .llmflow/ on init (config.yml, impl.md, review.md, skills/)
│   └── docs/state.md
└── internal/
    ├── config/config.go       # workspace discovery, path helpers, YAML config
    ├── events/events.go       # append-only JSONL state machine
    ├── git/git.go             # all git ops via exec.Command
    ├── archive/archive.go     # copy .task/ + diff.patch + meta.json before cleanup
    ├── orchestrator/          # background goroutine: claim tickets, stall detection
    │   └── orchestrator.go
    └── tui/tui.go             # Bubble Tea TUI: 5 panels, channel-driven refresh
```

---

## Workspace layout (what `llm-flow init` creates)

```
<workspace>/
├── .llmflow/
│   ├── config.yml             # max_agents, poll_interval_seconds, stall_timeout_minutes, agent_command, merge_strategy
│   ├── impl.md                # system prompt injected into impl agent sessions
│   ├── review.md              # system prompt injected into QA agent sessions
│   └── skills/                # human-triggered markdown skills (not used by agents)
├── docs/state.md              # human-maintained project state (updated after each merge)
├── queue/                     # unclaimed tickets: ticket-NNNNN.md files
├── archive/                   # permanent record: archive/ticket-NNNNN/ per completed ticket
├── events.jsonl               # append-only JSONL — sole source of truth for ticket state
└── project/
    └── worktrees/
        ├── main/              # canonical branch (cloned repo)
        └── ticket-NNNNN/      # one git worktree per active ticket
            └── .task/         # gitignored; brief.md, log.md, review.md
```

---

## Ticket lifecycle

```
llm-flow new-ticket ticket-00001 "Add login page"
  → creates queue/ticket-00001.md
  → appends {state: queued} to events.jsonl

Orchestrator tick (every N seconds):
  → claims queue/ticket-00001.md
  → git worktree add project/worktrees/ticket-00001 -b work/ticket-00001
  → moves brief → .task/brief.md
  → creates .task/log.md
  → removes queue/ticket-00001.md (atomic claim lock)
  → appends {state: in-progress}
  → surfaces spawn command to TUI: "cd project/worktrees/ticket-00001 && claude"

Impl agent works, commits, appends {state: pending-review} to events.jsonl

Orchestrator auto-commits any WIP on pending-review worktrees before QA

QA agent reads brief + log + diff, writes .task/review.md
  → appends {state: pending-human-review} or {state: in-progress} (if blocking issues)

Human runs:
  llm-flow review ticket-00001   # prints brief, log, diff, QA review
  llm-flow merge ticket-00001    # squash-merges → main, archives, removes worktree
  llm-flow reject ticket-00001   # archives as _rejected/, returns brief to queue/
  llm-flow manual ticket-00001   # human takes over; llm-flow finish when done
```

**State machine:**
```
queued → in-progress → pending-review → pending-human-review → done
                     ↑               ↓
                     └─ in-progress ←┘  (QA requests revision)
                                      ↓
                                   rejected

pending-human-review → human-manual → pending-review (via finish)
                                    → rejected
```

**Critical invariant:** `events.jsonl` is the sole source of truth for ticket state. Ticket `.md` files carry content (brief, log, review), never status. State is always derived by replaying events.

---

## CLI commands (all 10)

| Command | Description |
|---------|-------------|
| `llm-flow init <dir>` | Scaffold workspace from embedded templates; initializes git repo if none exists |
| `llm-flow start` | Launch Bubble Tea TUI + start orchestrator goroutine |
| `llm-flow new-ticket <id> <title> [--deps <ids>] [--priority 1-5]` | Create ticket markdown in queue/ |
| `llm-flow review <id>` | Print brief, log, diff, QA review; show next actions |
| `llm-flow merge <id>` | Squash-merge to main, archive, remove worktree |
| `llm-flow reject <id> [--reason]` | Archive as _rejected, return brief to queue |
| `llm-flow finish <id>` | Commit WIP, transition to pending-review (hand off to QA) |
| `llm-flow manual <id>` | Enter human-manual state; prints cd path |
| `llm-flow status` | Print all ticket states (no TUI) |
| `llm-flow archive-list` | List archived tickets with diff/review presence |

---

## Internal packages

### `internal/config`
- `FindWorkspace(dir)` — walks up from cwd looking for `.llmflow/config.yml`
- `Load(workspace)` — parses `.llmflow/config.yml` into `Config` struct
- Path helpers: `QueueDir`, `ArchiveDir`, `WorktreesDir`, `MainWorktree`, `TaskDir`, `TaskWorktree`, `EventsFile`
- `Config` fields: `MaxAgents`, `PollInterval` (mapped from `poll_interval_seconds`), `StallTimeout` (mapped from `stall_timeout_minutes`), `AgentCommand`, `MergeStrategy`

### `internal/events`
- `Append(workspace, ticketID, fromState, toState, note)` — appends one JSON line with RFC4122 UUIDv4 + RFC3339 timestamp; returns the written `Event`
- `GetTicketState(workspace, ticketID)` — replays events, returns current state
- `GetAllTickets(workspace)` — returns `map[ticketID]currentState`
- `GetTicketEvents(workspace, ticketID)` — returns full ordered event history for one ticket
- `ActiveStates` — `map[string]bool` of states where a worktree is live (`in-progress`, `pending-review`, `human-manual`)
- Uses `O_APPEND|O_WRONLY|O_CREATE` for concurrent-safe writes

### `internal/git`
- `CreateWorktree(workspace, ticket)` — `git worktree add` on a new branch `work/<id>`
- `RemoveWorktree(workspace, ticket)` — `git worktree remove --force`
- `SquashMerge(workspace, ticket)` — merges to main with `feat: complete <id>` message, returns commit hash
- `IsClean(workspace, ticket)` — checks for uncommitted changes in the worktree
- `WIPCommit(workspace, ticket)` — commits everything with `wip(<ticket>): pre-handoff checkpoint [orchestrator]`
- `GetDiff(workspace, ticket)` — `git diff main..HEAD` from the worktree, excluding `.task/`
- `IsStalled(workspace, ticket, minutes)` — `git log --since=N minutes` returns empty
- `GetCommitCount`, `GetLastCommitTime` — used by TUI for the ACTIVE panel

### `internal/archive`
- `Archive(workspace, ticketID, outcome, mergeCommit, rejectionReason)` — copies `brief.md`, `log.md`, `review.md` (if exists), writes `diff.patch` and `meta.json` into `archive/<id>/` or `archive/<id>_rejected/` (collisions become `_rejected_2`, etc.)
- `meta.json` fields: `Ticket`, `Outcome`, `ArchivedAt`, `MergeCommit`, `RejectionReason`, `Events` (full event history)

### `internal/orchestrator`
- Single goroutine + `time.Ticker` + buffered `chan struct{}`
- `New(workspace, cfg)` / `Start()` / `Stop()`
- `Updates()` returns read-only channel; TUI blocks on it between refreshes
- `GetState()` returns snapshot of `Alerts []string` and `SpawnCommands []SpawnCommand`
- `DismissAlerts()`, `DismissSpawnCommand(ticket)`
- On each tick: (1) claim queued tickets up to `max_agents`, (2) check stalls, (3) auto-commit WIP on `pending-review` worktrees

### `internal/tui`
- Bubble Tea `Model` with `Init / Update / View`
- Five panels rendered in order: **SPAWN** (green border), **QUEUE**, **ACTIVE**, **AWAITING REVIEW** (yellow border), **ALERTS** (red border)
- Key bindings: `r` refresh, `a` dismiss alerts, `q`/`ctrl+c` quit
- Auto-refreshes every 15 seconds via `tea.Tick`; also refreshes on every orchestrator `Updates()` signal
- `Run(workspace)` is the only exported entry point — called from `startCmd`

---

## Key design decisions (do not revisit)

| Decision | Rationale |
|----------|-----------|
| `events.jsonl` as sole state source | Concurrent-safe POSIX append; no locking needed |
| `.task/` inside each worktree | Colocalizes context with work; no cross-worktree path math |
| QA agents are read-only | Enforces clean separation between impl and review phases |
| Stall detection via `git log --since` | No heartbeat files to manage or clean up |
| Human approves all merges | Nothing reaches main without explicit `llm-flow merge` |
| Squash-merge only | Clean linear history on main |
| All git ops via `exec.Command` | No libgit2 dependency; works wherever `git` is installed |
| `//go:embed all:templates` | Config, rules, skills ship inside the binary |
| Orchestrator surfaces spawn commands, doesn't run them | Human launches agent in a terminal; tool is agent-agnostic |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `github.com/spf13/cobra` | CLI commands and flags |
| `github.com/charmbracelet/bubbletea` | Elm-style TUI framework |
| `github.com/charmbracelet/lipgloss` | Terminal styles and borders |
| `gopkg.in/yaml.v3` | Parse `.llmflow/config.yml` |

All vendored. No network access needed to build.

---

## What is NOT implemented yet

The core pipeline is functional. Known gaps before production hardening:

- Error handling in `merge` and `reject` for edge cases (worktree already removed, branch already merged)
- `feedback` command (referenced in PRD OQ2, not yet implemented)
- Integration tests against real git repos (all git functions are implemented but untested end-to-end)

---

## Non-goals (v1)

- No automatic merging — human must run `llm-flow merge`
- No task bundling or AI-driven ticket assignment
- No remote/multi-machine coordination
- No web dashboard (deferred)
- No ticket dependency enforcement (the markdown format has a `## Dependencies` section, but the orchestrator ignores it)
- `improve-arch` skill outputs reports only, never writes code