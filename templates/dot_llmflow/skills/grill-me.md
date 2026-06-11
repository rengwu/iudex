# Skill: grill-me

**Purpose:** Interview the user relentlessly about a plan or design until every branch of the decision tree is resolved. Challenges plans against existing domain docs and sharpens terminology inline.

## How to use
Tell Claude: "Use the grill-me skill on my idea: [your idea]"

## What Claude does
1. Ask one probing question at a time — not a list dump. Wait for the answer before continuing.
2. For each question, provide a recommended answer so the user can redirect rather than answer from scratch.
3. If a question can be answered by exploring the codebase, explore instead of asking.
4. Challenge vague requirements ("what does 'fast' mean exactly?").
5. Surface hidden assumptions ("you said users — authenticated? anonymous? both?").
6. Walk down each branch of the design tree, resolving dependencies between decisions one at a time.

## Domain docs

Check `docs/glossary.md` and `docs/adr/` before starting. If they exist:
- When the user uses a term that conflicts with the glossary, call it out immediately.
- When the user uses a vague or overloaded term, propose the canonical term from the glossary.
- When a term is resolved during the session, update `docs/glossary.md` right there — don't batch.
- Cross-reference with the code: if the user states how something works, verify it.

If `docs/glossary.md` doesn't exist yet, create it lazily when the first term is resolved.

### Glossary format

```md
# Project Glossary

**Ticket**:
A unit of work tracked by its lifecycle in events.jsonl. Identified by a ticket-NNNNN
ID (the "task-" prefix is a file-naming convention; the concept is always called a ticket).
_Avoid_: issue, card (use ticket); task (use only as part of the ID, e.g. ticket-00001)

**Queue**:
The set of unclaimed tickets waiting in queue/ for an agent to pick up.
_Avoid_: backlog
```

Rules: one or two sentences, define what it IS not what it does. List rejected synonyms under `_Avoid_`.

## ADRs

Offer to create an ADR only when all three are true:
1. **Hard to reverse** — cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **Real trade-off** — genuine alternatives existed and one was chosen for specific reasons

ADRs live at `docs/adr/NNNN-slug.md`. Scan the directory for the highest existing number and increment. A single paragraph stating what was decided and why is enough.

## Goal
End with a clear, honest picture of what the user actually wants to build — not what they said they wanted to build. Summarise findings when satisfied, framing them as inputs to `write-prd`.
