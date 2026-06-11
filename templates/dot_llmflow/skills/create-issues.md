# Skill: create-issues

**Purpose:** Break a PRD or plan into well-scoped, actionable tickets in `queue/` using vertical (tracer-bullet) slices.

## How to use
Tell Claude: "Use create-issues to generate tickets from docs/prd/<name>.md"

## Process

### 1. Gather context
Work from whatever is in the conversation. If given a PRD path, read it in full. Explore `project/worktrees/main` to understand existing code. Use vocabulary from `docs/glossary.md` in ticket titles and descriptions.

### 2. Draft vertical slices

Each ticket is a thin vertical slice — a narrow but COMPLETE path through all layers end-to-end, not a horizontal slice of one layer.

**Slices are either:**
- **AFK** — fully specified; an agent can implement and complete it without human interaction. Prefer these.
- **HITL** — requires human input (architectural decision, design review, manual testing). Use only when necessary.

Rules for good slices:
- Each slice delivers something demoable or verifiable on its own
- Each slice has explicit dependencies on other slices (none, or by ticket ID)
- Prefer many thin slices over few thick ones
- One clear unit of work per ticket — completable in one agent session

### 3. Quiz the user

Present the proposed breakdown as a numbered list. For each slice show:
- **Title**: short descriptive name
- **Type**: HITL / AFK
- **Blocked by**: which tickets must complete first (or "none")

Ask:
- Does the granularity feel right?
- Are the dependency relationships correct?
- Should any slices be merged or split?
- Are the HITL/AFK labels correct?

Iterate until the user approves.

### 4. Write tickets

For each approved slice, determine the next available ticket ID by scanning `queue/` for existing `ticket-NNNNN.md` files. Write tickets in dependency order (blockers first).

For each ticket, write `queue/ticket-NNNNN.md`:

```markdown
# ticket-NNNNN: <title>

_Priority: N/5_
_Type: AFK | HITL_
_Blocked by: ticket-NNNNN | none_

## Problem Statement
What needs to be done and why. Describe end-to-end behavior, not layer-by-layer implementation.
Avoid specific file paths — they go stale. Exception: prototype snippets encoding a decision
precisely (state machine, type shape); inline and note they came from a prototype.

## Acceptance Criteria
- [ ] ...
- [ ] ...

## Notes
Context, links, constraints, or relevant domain terms from docs/glossary.md.
```

After writing all files, run `llm-flow new-ticket <id> "<title>"` for each ticket so it is registered in `events.jsonl` with state `queued`. Do this in dependency order.
