# Skill: handoff

**Purpose:** Compact the current conversation into a handoff document so a fresh agent can continue the work without losing context.

## How to use
Tell Claude: "Use handoff [to prepare for: <focus of next session>]"

## What Claude does

Write a handoff document and save it to the OS temp directory (`$TMPDIR/iudex-handoff-<timestamp>.md`). Tell the user the absolute path.

### Document structure

```markdown
# Handoff: <one-line summary of what was being worked on>

_Date: YYYY-MM-DD_
_Focus for next session: <from user args, or "general continuation">_

## Context

What was being accomplished and why. 1–3 paragraphs max.

## Current workspace state

- Active tickets: output of `iudex status` (include states)
- Relevant queue/ tickets: list with IDs and titles
- Key files changed this session: paths relative to workspace root

## Artifacts produced

References only — do not duplicate content:
- PRD: docs/prd/<name>.md
- ADRs: docs/adr/NNNN-slug.md
- Arch review: docs/design/arch-review-YYYY-MM-DD.md
- Tickets: queue/ticket-NNNNN.md

## What was decided

Decisions made this session that are NOT yet written into PRDs, ADRs, or tickets.
Keep this short — if it's important, it should be in one of the artifacts above.

## Blockers and open questions

Unresolved decisions or information the next agent will need.

## Suggested next steps

Concrete actions the next agent should take first, in order:
1. [Action] — e.g. "Run `iudex status` to see current ticket states"
2. [Action] — e.g. "Use grill-me on the open question about X"
3. [Action] — e.g. "Use create-tickets from docs/prd/feature.md"
```

## Rules

- Do not duplicate content already captured in PRDs, ADRs, tickets, or diffs — reference by path instead.
- Redact sensitive information (API keys, credentials).
- Do not save to the workspace — it is a temporary artifact for the next session only.
- If the user provided args, treat them as the focus for the next session and tailor the document accordingly.
