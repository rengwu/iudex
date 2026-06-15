# iudex

Turn a pile of coding agents into a production line. Multi-agent coding without the multi-agent mess.

![Iudex Logo](./docs/assets/logo_small.png)

A CLI that orchestrates AI coding agents across git worktrees. It drives every ticket through a **queue → implement → QA → human review → merge** pipeline, keeping all state file-based and git-native with no runtime dependency beyond `git`.

There's **no daemon and no TUI**. iudex is just rules over an append-only event log: every step is an explicit command you run, and nothing reaches `main` without your approval. Each ticket gets its own git worktree; iudex prints ready-to-paste commands to spawn an agent into it, but never launches one itself.

```
author tNN.md → queue → activate → [impl agent] → finish
              → [QA agent] → qa approve → human-qa approve → merged to main
```

## Install

Requires Go 1.22+.

```bash
go build -o iudex .
# put the binary on your PATH and use it like git, inside any project
```

## Quick start

Run `iudex` **inside your project** — it scaffolds in place.

```bash
cd ~/code/my-project
iudex init                              # creates .iudex/ and gitignores it

# 1. Author a ticket as plain markdown, then register it
vim .iudex/queue/t$(iudex next-ticket-id).md
iudex queue t1                          # or: iudex queue t2 --deps t1

# 2. Start work: creates a worktree and prints the impl spawn command
iudex activate t1
#   → cd .iudex/worktrees/t1 && claude "$(cat .iudex/prompts/impl.md)"

# 3. The agent (or you) implements, commits, then from inside the worktree:
iudex finish                            # → pending-qa, prints the QA spawn command

# 4. A fresh QA agent reviews, writes .task/review.md, then:
iudex qa approve                        # or: iudex qa reject  (back to active)

# 5. You make the call
iudex review t1                         # brief, log, diff, QA review, next actions
iudex human-qa approve t1               # merge to main, archive, remove the worktree
```

Check progress any time with `iudex status`.

## Before the queue: shaping work

The CLI starts at `iudex queue`. The step _before_ that — turning a raw idea into robust, sliced, dependency-ordered tickets — is handled by a set of **bundled skills** that `iudex init` scaffolds into `.iudex/skills/` and indexes in a tracked root `AGENTS.md`. Your agent reads that index and loads the relevant skill on demand:

```
grill-me / grill-with-docs → prototype → to-prd → to-issues → iudex queue
      (stress-test)          (validate)   (spec)    (slice)
```

- **grill-me / grill-with-docs** — get relentlessly interviewed about a plan until it holds up; the docs variant also maintains a domain glossary and ADRs under `.context/`.
- **prototype** — throwaway code (a terminal logic app or UI variants) to validate a design before committing.
- **to-prd** — synthesize the discussion into a PRD at `.context/prd/<slug>.md`.
- **to-issues** — slice a plan/PRD into tickets and register them with `iudex queue tN --deps …` (a slice's blockers become iudex dependencies).
- **improve-codebase-architecture** — find refactoring opportunities that feed back into the funnel.

The skills only ever _call_ iudex; iudex stays unaware of them. `.context/` is tracked project documentation (committed), so its glossary, ADRs, and PRDs travel into ticket worktrees where the impl and QA agents can read them.

## Commands

| Command                               | Description                                                              |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `iudex init`                          | Scaffold the current directory into a workspace                          |
| `iudex next-ticket-id`                | Print the next ticket id and nothing else                                |
| `iudex queue <id> [--deps <ids>]`     | Register an authored ticket and its dependencies                         |
| `iudex activate <id>`                 | Start a queued ticket: create its worktree, print the impl spawn command |
| `iudex finish [id]`                   | Hand off to QA (auto-commits if dirty); id inferred from the worktree    |
| `iudex spawn [id]`                    | Reprint the spawn command for a ticket's current state                   |
| `iudex qa approve\|reject [id]`       | Agent QA decision                                                        |
| `iudex human-qa approve\|reject <id>` | Your decision: merge, or send back for revision (`--reason`)             |
| `iudex retry <id>`                    | Reset a failed ticket for another attempt                                |
| `iudex remove <id>`                   | Abandon a ticket                                                         |
| `iudex review <id>`                   | Print brief, log, diff, QA review, state, and next actions               |
| `iudex status [--all]`                | Tickets grouped by state                                                 |

Commands run by an agent inside a worktree (`finish`, `qa`, `spawn`) infer the ticket from the current directory, so no id is needed.

## Ticket dependencies

Declare blockers at registration. A ticket can't be activated until every dependency is `done`:

```bash
iudex queue t2 --deps t1,t3
```

Dependencies must already be registered, which keeps the graph acyclic by construction. `iudex status` shows what each queued ticket is `blocked by` or whether it's `ready`.

## States

`queued → active → pending-qa → pending-human-qa → done`, plus `failed` (too many QA rejections — recover with `iudex retry`) and `removed` (abandoned with `iudex remove`).

## Configuration

`.iudex/config.yml`:

| Field                    | Meaning                                                |
| ------------------------ | ------------------------------------------------------ |
| `main_branch`            | Branch tickets merge into (your repo's branch at init) |
| `max_active`             | Max tickets active at once (`0` = unlimited)           |
| `qa_reject_limit`        | QA rejections before a ticket is marked `failed`       |
| `agent_command`          | Command used in spawn lines (e.g. `claude`)            |
| `merge_strategy`         | `no-ff` or `squash`                                    |
| `merge_message_template` | Merge commit message (`{{.Ticket}}` is substituted)    |
| `branch_prefix`          | Per-ticket branch prefix (e.g. `work/`)                |

Edit `.iudex/prompts/impl.md` and `review.md` to customize the instructions baked into spawn commands.

## Workspace layout

```
<your-project>/             # your repo = the canonical "main" worktree
├── .iudex/                 # all iudex state (gitignored)
│   ├── config.yml
│   ├── prompts/            # impl.md, review.md
│   ├── skills/             # bundled work-shaping skills (<name>/SKILL.md)
│   ├── queue/              # author tickets here: t<N>.md
│   ├── archive/            # archive/t<N>/ per done/removed ticket
│   ├── events.jsonl        # append-only source of truth
│   └── worktrees/t<N>/     # one worktree per active ticket (+ .task/ context)
├── AGENTS.md               # tracked; indexes the skills (init appends its section)
└── .context/               # tracked project docs (glossary, adr/, prd/) — lazily created
```
