# iudex — Agent Orientation

iudex orchestrates parallel AI coding agents across git worktrees. Tickets move through a file-based pipeline: queue → implement → QA → human review → merge. You are operating at the project root (the folder containing `.iudex/`).

---

## Workspace layout

```
<workspace>/
├── .iudex/
│   ├── config.yml        # max_agents, poll_interval, stall_timeout, agent_command
│   ├── impl.md           # rules for implementation agents
│   ├── review.md         # rules for QA agents
│   └── skills/           # slash-command skills (see below)
├── docs/
│   └── state.md          # human-maintained project state — read this for context
├── queue/                # unclaimed tickets: ticket-NNNNN.md files
├── archive/              # completed and rejected tickets
├── events.jsonl          # source of truth for all ticket states (append-only)
└── project/
    └── worktrees/
        ├── main/         # canonical branch — the live codebase
        └── ticket-NNNNN/ # one git worktree per active ticket
            └── .task/    # brief.md, log.md, review.md (gitignored)
```

---

## Ticket pipeline

```
queued → in-progress → pending-review → pending-human-review → done
                                      ↓
                                   rejected
```

State is derived solely by replaying `events.jsonl` — never infer state from the filesystem alone.

---

## Creating tickets

Pre-write a ticket directly to `queue/ticket-NNNNN.md`, then register it:

```bash
iudex new-ticket ticket-NNNNN "Title"
# If the file already exists, iudex new-ticket reconciles it — no need to delete first.
```

Or use the `create-tickets` skill to generate a full ticket breakdown from a PRD.

### Ticket format

```markdown
# ticket-NNNNN: <title>

_Priority: N/5_
_Type: AFK | HITL_
_Blocked by: ticket-NNNNN | none_

## Problem Statement
## Acceptance Criteria
- [ ] ...
## Notes
```

---

## Git convention

- Each ticket gets a worktree at `project/worktrees/ticket-NNNNN/` on branch `work/ticket-NNNNN`
- Branches fork from `main` — all project code lives in `project/worktrees/main/`
- **Never commit directly to main** — the human merges via `iudex merge`
- **Never touch another ticket's worktree**
- `.task/` inside each worktree is gitignored — it holds agent context, not implementation

---

## iudex CLI (human commands)

| Command | What it does |
|---|---|
| `iudex new-ticket <id> <title>` | Create or register a ticket in queue |
| `iudex status` | Print all ticket states |
| `iudex review <id>` | Show brief, log, diff, QA review |
| `iudex merge <id>` | Squash-merge to main, archive, clean up |
| `iudex reject <id> [--reason]` | Archive as rejected, return brief to queue |
| `iudex manual <id>` | Human takes over the worktree |
| `iudex finish <id>` | Commit WIP, hand off to QA |
| `iudex archive-list` | List completed/rejected tickets |
| `iudex start` | Launch TUI + orchestrator |

---

## Available skills

Skills live in `.iudex/skills/`. Tell the agent: *"Use \<skill-name\> to..."*

| Skill | Purpose |
|---|---|
| `create-tickets` | Break a PRD into well-scoped vertical-slice tickets in `queue/` |
| `triage` | Process incoming ideas/bugs through a state machine into tickets or rejections |
| `write-prd` | Produce a structured PRD from a grilled idea |
| `grill-me` | Relentlessly interview until a plan is fully resolved |
| `tdd` | Build features using red-green-refactor TDD |
| `prototype` | Build a throwaway prototype to answer a design question |
| `improve-arch` | Scan for architectural friction, produce a report (read-only — no code changes) |
| `caveman` | Ultra-compressed communication mode (~75% token reduction) |
| `handoff` | Compact the conversation into a handoff doc for a fresh agent |
| `write-a-skill` | Create a new skill for this workspace |

---

## Rules

- **Never merge to main** — only the human runs `iudex merge`
- **Never modify `.task/review.md`** — that belongs to the QA agent
- **Never modify files outside your assigned worktree**
- `events.jsonl` is append-only — never edit or delete lines
- Leave a clean working tree when handing off (`git status` shows nothing to commit)
