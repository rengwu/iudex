> **Status note (2026-07-04):** the `iudex spec` CLI command (parser, lint, --fix) has
> been removed. The `REQ-N` heading convention and the GUI Specifications view remain.
> Parsing and lint moved into the GUI (`gui/src/lib/spec.ts` — a display concern, not
> state-machine logic); id minting moved into the to-prd skill as an explicit
> grep-derived numbering pass (file-scoped max+1, append-only). Rationale: the CLI
> stays minimal and pipeline-only; ids are derived, never stored.

# Specifications & the REQ-N requirement format

Make the PRD a first-class, browsable, machine-readable artifact in iudex — the
durable source of truth for *intent* (what the project should be), sitting
alongside `events.jsonl`, the source of truth for *work state*. This PRD defines
a tiny requirement-format convention, the CLI surface that owns parsing it, and
a read-only **Specifications** view in the GUI that lists PRDs and the
requirements synthesized from them.

> This document dogfoods the convention it defines: every requirement below is a
> `### REQ-N:` heading, with `> status:` lines where relevant.

---

## Problem

Today a PRD is born in the `to-prd` skill, consumed once by `to-issues`, and
then left to rot in `.context/prd/`. It is scaffolding, not a spine. Nothing
reads it back, nothing tracks whether the project still matches it, and there is
no structured handle on an individual requirement. We want the PRD to be a live,
inspectable thing — and the first step is giving requirements a stable identity
and a parser, then surfacing them in the GUI.

## Goals

- A **minimal, enforceable format** that turns a freeform PRD into a list of
  identifiable requirements without losing its human-readable markdown nature.
- The CLI **owns parsing** (single source of truth); GUI and skills consume it.
- A **read-only Specifications view**: list PRDs, render raw md, show the
  synthesized requirement list.

## Non-goals (v1)

- **Coverage** (requirement → ticket state) and the `--satisfies` link — see
  REQ-7, deferred to v2.
- **In-app editing** of PRDs — the view is read-only; authoring stays in the
  skills / external editor (REQ-5).
- The **conversation-first shaping** surface — its own future project, gated on
  an agent↔GUI structured-turn protocol spike. Out of scope here (REQ-8).

---

## The format (normative)

A requirement is the only structured element. The whole contract:

1. **A requirement is a markdown heading whose text matches `REQ-<n>: <title>`** —
   any heading level (`#`/`##`/`###`/…). Section headings without the marker
   (e.g. `## Payment`) are ordinary prose.
2. **IDs are file-scoped integers, append-only** — never reused, never
   renumbered. Reference a requirement across files as `checkout.md#REQ-3`.
3. **A draft requirement may be written `REQ-?:`** (or with no number);
   `iudex spec lint --fix` assigns the next free number in that file.
4. **Status** is an optional `> status: <value>` line directly under the
   heading, where `<value>` is `active` (default if omitted), `parked`
   (deferred but intended), or `out-of-scope` (deliberately not building).
   Other `> key: value` lines (e.g. `> note:`) are permitted and ignored by v1.
5. **Body** = the prose from the requirement heading until the next requirement
   heading or a same-or-shallower section heading.

### Example — `.context/prd/checkout.md`

```markdown
# Checkout

How a shopper pays and gets confirmation.

## Payment

### REQ-1: Card payment via Stripe
Users complete purchase with a saved or new card; failures surface a retryable error.

### REQ-3: Promo codes & discounts
One code per order (no stacking); percentage or fixed amount; expirable;
expired → reject with a retryable error.

## Confirmation

### REQ-5: Gift receipts
> status: parked
> note: revisit post-launch
Hide prices on a printable receipt.
```

`iudex spec --json` over that file:

```json
{ "prds": [ { "file": "checkout.md", "title": "Checkout", "requirements": [
  { "id": "REQ-1", "title": "Card payment via Stripe", "status": "active", "body": "Users complete…" },
  { "id": "REQ-3", "title": "Promo codes & discounts", "status": "active", "body": "One code per order…" },
  { "id": "REQ-5", "title": "Gift receipts",           "status": "parked", "body": "Hide prices…" }
] } ] }
```

---

## Requirements

### Section A · CLI (the critical path — skills and GUI depend on it)

### REQ-1: Requirement-format parser
A new `internal/spec` package parses every `.context/prd/*.md` into
`{file, title, requirements[]}`, where each requirement is
`{id, title, status, body}`. The parser is the executable definition of the
format above (parser = spec) — there is no separate prose grammar to keep in
sync. Unrecognized or malformed sections **degrade gracefully**: they never
abort the parse and never vanish (the raw md remains ground truth).

### REQ-2: `iudex spec --json`
A read command that emits all PRDs under `.context/prd/`, structure only (no
ticket/coverage join). This is the GUI's read path for the Specifications view,
single-sourced exactly like `status --json` / `config --json`.

### REQ-3: `iudex spec lint [file] [--fix]`
Validates the format and reports issues: a `REQ-` heading missing `: title`,
duplicate IDs in a file, an unknown `status` value, an unresolved `REQ-?`
placeholder. **Warn-first** — exits 0 with warnings during adoption; tightens to
non-zero (blocking) once the format is established. `--fix` assigns missing
file-scoped IDs (max-in-file + 1) and is the single authority for ID minting.

### REQ-4: Append-only ID assignment
ID minting lives only in the CLI (REQ-3's `--fix`), guaranteeing the
never-reuse / never-renumber rule even when two skills edit the same PRD.
Mirrors `next-ticket-id`'s "highest ever + 1" discipline.

### Section B · Skills

### REQ-5: Authoring skills emit the format
`to-prd` and `to-issues` write requirements as `REQ-?:` headings (plus optional
`> status:`), then run `iudex spec lint --fix` as a round-trip self-check and
fix what they can. They reference the single canonical definition (the lint
command), not a re-described copy, so they cannot drift from it.

### Section C · GUI (read-only, on `feat/gui-read-path`)

### REQ-6: Specifications view
A new view that shells `iudex spec --json` through the existing `run_iudex`
bridge and renders: a PRD list (left), the selected PRD's raw markdown via the
already-bundled Monaco editor in **read-only** mode (center), and the flat
synthesized requirement list with status chips (right). Registered by swapping a
`Stub` in `nav.ts`. No new Rust command required — it reuses the CLI read path,
holding no authoritative state, consistent with the GUI invariant.

### Section D · Deferred

### REQ-7: Coverage & requirement→ticket linkage
> status: parked
`iudex queue --satisfies checkout.md#REQ-3` (repeatable, many-to-many) records
the link on the queue event; `spec --json` gains a coverage join
(requirement → satisfying tickets → derived done/in-flight/gap); the view gains
a coverage overlay. Deferred until the format proves itself in real use.

### REQ-8: Conversation-first shaping surface
> status: out-of-scope
> note: separate project; gated on an agent↔GUI structured-turn protocol spike
The chat-driven "spec precipitates as you talk" surface (clickable choice chips,
live-crystallizing spec, derived tickets). Introduces the GUI's first
authoritative state (an append-only conversation thread) and a structured agent
protocol. Explicitly not part of this initiative.

---

## Decisions ledger

| Area | Decision |
|---|---|
| ID scope | File-scoped integers; reference `file.md#REQ-N` |
| ID lifecycle | Append-only — never reuse, never renumber |
| ID assignment | CLI mints via `spec lint --fix` (max-in-file + 1) |
| Parser home | CLI owns it (`iudex spec --json`); GUI/skills consume |
| Marker | Any heading whose text starts `REQ-<n>:` (level-agnostic) |
| Status | `> status:` line; `active` (default) / `parked` / `out-of-scope`; extra `> key:` lines allowed, ignored in v1 |
| Grouping | Flat requirement list for v1; sections are raw-md prose |
| `spec --json` | All PRDs, structure only (no coverage) |
| Coverage / linkage | Deferred to v2 (REQ-7) |
| Enforcement | Standalone `spec lint`, warn-first → block later |
| Spec view v1 | Read-only: list + raw md + flat requirement list |

## Build sequence

1. **CLI (Go)** — critical path. `internal/spec` parser + `iudex spec --json` +
   `iudex spec lint [--fix]`, with CLI-seam tests. (REQ-1–4)
2. **Skills** — parallel after CLI. `to-prd`/`to-issues` emit the format and
   self-check via lint. (REQ-5)
3. **GUI** — parallel after CLI. Specifications view consuming `spec --json`.
   (REQ-6)
4. **v2** — `--satisfies`, coverage, overlay; then tighten lint to blocking.
   (REQ-7)

The CLI is the only hard dependency; once `spec --json` + `lint` exist, skills
and GUI proceed independently. v1 ships value — PRDs as a first-class browsable
artifact — without coverage, linkage, or any conversation work.

## Open questions

- **Legacy PRDs** (`gui-client.md`, `gui-client-as-built.md`) predate the format
  and will show an empty requirement list (raw md still renders). Retrofit with
  `REQ-N` headings, or leave as-is? Leaning leave-as-is; retrofit on demand.
- **`spec lint` blocking cutover** — what signal flips warn → block? Probably
  "all actively-authored PRDs parse clean," judged manually, not automated.
