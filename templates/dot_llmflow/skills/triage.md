# Skill: triage

**Purpose:** Triage incoming ideas, bugs, and feature requests through a structured state machine. Produces well-specified tickets in `queue/` ready for an agent to pick up, or records rejections in `docs/out-of-scope/`.

## How to use
Tell Claude: "Use triage to [review this idea / look at ticket-NNNNN / show me what needs attention]"

## The issue tracker for this repo

This workspace tracks work through `queue/ticket-NNNNN.md` files and `events.jsonl`. There is no external issue tracker. Ticket states are:

```
queued → in-progress → pending-review → pending-human-review → done
                                                              → rejected
```

"Ready for agent" = a well-formed ticket in `queue/` (state: `queued`).
"Ready for human" = a ticket that needs a human-manual step (flagged in ticket notes).

## Roles

Category:
- `bug` — something is broken
- `enhancement` — new feature or improvement

State:
- `needs-triage` — not yet evaluated
- `needs-info` — waiting on requester for more detail
- `ready-for-agent` — fully specified; write to `queue/` and register with `llm-flow new-ticket`
- `ready-for-human` — needs human judgment; write to `queue/` with HITL flag
- `wontfix` — will not be actioned; record in `docs/out-of-scope/`

## Invocation

The human invokes triage and describes what they want in natural language:
- "Show me what needs attention" → show existing queue/ and any informal notes
- "Triage this idea: [description]" → evaluate a new idea
- "Move ticket-00003 to ready-for-agent" → quick state override

## Show what needs attention

Run `llm-flow status` and present tickets grouped by state. Highlight anything in `pending-human-review` that needs action. Let the human pick.

If there are informal ideas not yet in `queue/`, ask the human to describe them.

## Triage a specific idea or ticket

1. **Gather context.** If a ticket ID is given, read `queue/ticket-NNNNN.md`. Explore `project/worktrees/main` to understand the codebase. Read `docs/glossary.md` and `docs/adr/` for relevant decisions. Check `docs/out-of-scope/` for prior rejections resembling this request.

2. **Recommend.** State your category and state recommendation with reasoning, plus a brief codebase summary relevant to the request. Wait for direction.

3. **Grill (if needed).** If the request needs fleshing out, run a grilling session (see `grill-me`): one question at a time, recommend an answer for each. Update `docs/glossary.md` inline as terms are sharpened.

4. **Apply the outcome:**
   - `ready-for-agent` → write the ticket (see `create-issues`) and register it
   - `ready-for-human` → write the ticket with HITL flag and HITL notes
   - `needs-info` → write notes for the requester (template below) and stop
   - `wontfix` (enhancement) → write to `docs/out-of-scope/` (see below)
   - `wontfix` (bug) → note why it's not a bug or not actionable

## Quick state override

If the human says "move ticket-NNNNN to ready-for-agent", trust them and act. Confirm what you're about to do, then proceed. Skip grilling. Ask if they want to write an agent brief.

## Needs-info template

Write this as a comment in the ticket file under a `## Triage Notes` section:

```markdown
## Triage Notes

**What we've established:**
- point 1

**What we still need:**
- specific question 1
- specific question 2
```

Questions must be specific and actionable, not "please provide more info".

## Agent brief (for ready-for-agent tickets)

When a ticket moves to `ready-for-agent`, ensure it has a clear agent brief in the Problem Statement. Principles:
- **Behavioral, not procedural.** Describe what the system should do, not how. Good: "The orchestrator should claim at most `max_agents` tickets per tick." Bad: "Edit line 42 of orchestrator.go."
- **Durable.** Don't reference line numbers. Name exported types, functions, and config fields.
- **Complete acceptance criteria.** Each criterion must be independently verifiable with `go test` or by running `llm-flow <command>`.
- **Explicit scope boundary.** State what is out of scope to prevent gold-plating.

## Out-of-scope knowledge base

`docs/out-of-scope/` stores persistent records of rejected **enhancement** requests.

One file per concept, kebab-case (`web-dashboard.md`, `remote-coordination.md`). Multiple requests for the same concept are grouped under one file.

Format:
```markdown
# Web Dashboard

This project does not support a web dashboard in v1.

## Why this is out of scope

The pipeline is designed to be file-based and git-native with no runtime
dependencies. A web dashboard would require a persistent server process,
contradicting this core constraint.

## Prior requests

- "Add web UI to monitor ticket status" (2026-06-12)
```

When checking: read all files in `docs/out-of-scope/`. On a concept match, surface it: "We've deferred this before because [reason]. Do you still feel the same way?" The human may confirm (close), reconsider (delete/update), or clarify it's distinct (proceed normally).
