# iudex — Product Requirements Document (v1 rewrite)

Status: ready-for-agent

## Problem Statement

A developer wants to run AI coding agents across isolated git worktrees with a disciplined queue → implement → QA → human-review → merge flow, but doesn't want a daemon, a database, a background loop, or a TUI to babysit. They want a single globally-installed binary — used like `git` or `docker` — that they run inside their own project, that tracks ticket state in a file, enforces dependency ordering and review gates, and never moves a ticket forward on its own. Every transition should be an explicit command the human (or an agent acting on the ticket) runs.

## Solution

iudex is a single Go binary, installed globally, run inside an existing project. `iudex init` scaffolds the project in-place into a workspace. The user authors ticket markdown files, registers them with `iudex queue`, and drives each ticket through the pipeline with explicit commands. iudex owns: the append-only event log (sole source of truth for status), git worktree lifecycle, dependency enforcement, the QA-rejection failure limit, archiving, and generating (never launching) agent spawn commands. There is no background process — `iudex status` is a one-shot print, and nothing advances without a command.

## User Stories

### Install and init
1. As a developer, I want `iudex` installed globally so I can run it in any project like `git`.
2. As a developer, I want `iudex init` to scaffold the current folder whether it's empty, an existing git repo, or a project with working files, so I never restructure my project to adopt iudex.
3. As a developer, I want init to `git init` and make an initial commit only when the repo has no commits yet, so existing history is untouched.
4. As a developer, I want init to record my repo's current branch as `main_branch` in config, so iudex merges to the right canonical branch even if it's `master` or something else.
5. As a developer, I want all iudex state under a single `.iudex/` directory that init adds to `.gitignore`, so my project history is never polluted by iudex operational files or worktree checkouts.
6. As a developer, I want init to scaffold `.iudex/{config.yml, prompts/impl.md, prompts/review.md, queue/, archive/, worktrees/, events.jsonl}` from templates embedded in the binary, so setup needs no network.

### Authoring and queueing tickets
7. As a developer, I want to write ticket briefs as plain markdown files named `t<id>.md` in `.iudex/queue/`, so I author work in my editor with no tool friction.
8. As a developer, I want `iudex next-ticket-id` to print the next id `N` (highest ever registered + 1) and nothing else, so I can script `vim .iudex/queue/t$(iudex next-ticket-id).md`.
9. As a developer, I want `iudex queue <id> --deps <ids>` to register a queued ticket and its blocking dependencies in the event log, so dependency relationships are captured at registration.
10. As a developer, I want `--deps` to be omittable for a ticket with no blockers, so unblocked work is trivial to register.
11. As a developer, I want `queue` to reject an id that was ever registered before, so ticket ids are never reused.
12. As a developer, I want `queue` to reject a dep that isn't already registered (or is already `removed`/`failed`), so typos and impossible dependencies are caught immediately and the dependency graph stays a DAG by construction.
13. As a developer, I want the markdown file itself to carry no status or dependency data, so the event log is the single source of truth and there's no file-vs-log drift.

### Activating work
14. As a developer, I want `iudex activate <id>` to move a queued ticket to `active`, refusing if any registered dep isn't `done` yet (printing which deps block it), so work never starts out of order.
15. As a developer, I want activation to refuse when the `max_active` cap is reached, so I don't accidentally spin up more concurrent worktrees than intended.
16. As a developer, I want activation to create a git worktree at `.iudex/worktrees/t<id>/` on a `work/t<id>` branch off `main`, so each ticket is isolated.
17. As a developer, I want activation to move the queue file into `.task/brief.md` and create an empty `.task/log.md`, so the brief travels with the work and the impl agent has a journal. `.task/` is gitignored inside the worktree.
18. As a developer, I want activation to print a ready-to-paste impl spawn command, so I can launch an agent in one copy-paste.

### Implementation phase
19. As an impl agent, I want my brief at `.task/brief.md` and a `.task/log.md` to journal decisions and handoff notes, so QA has context beyond commit messages.
20. As an impl agent, I want to run `iudex finish` from inside my worktree (ticket inferred from cwd) to move the ticket to `pending-qa`, so I don't have to know or type my ticket id.
21. As an impl agent, I want `finish` to auto-commit a checkpoint if the worktree is dirty, so no work is lost at handoff even if I forgot to commit.
22. As a developer, I want to optionally pick up an `active` ticket and work in its worktree myself, then run `iudex finish` exactly as an agent would, so human and agent implementation share one path. The worktree is preserved at this stage.
23. As a developer, I want `finish` to print the QA spawn command, so review starts in one copy-paste.

### Agent QA phase
24. As a QA agent, I want to be spawned fresh into the same worktree to review the impl work, reading brief, log, and the diff vs main.
25. As a QA agent, I want to write a structured review to `.task/review.md`, so my findings persist for the human and the next impl attempt.
26. As a QA agent, I want `iudex qa approve` to move the ticket to `pending-human-qa`.
27. As a QA agent, I want `iudex qa reject` to move the ticket back to `active` for revision; my `review.md` is the feedback channel the next impl session reads.
28. As a developer, I want each `qa reject` to increment a cumulative counter, and the ticket to become `failed` (worktree preserved) when it reaches `qa_reject_limit`, so two agents can't ping-pong forever without converging.

### Human QA phase
29. As a developer, I want `iudex review <id>` to print brief, log, diff vs main, `review.md`, current state, and the next-action commands, so I can make the human-QA decision in one place.
30. As a developer, I want `iudex human-qa approve <id>` to set the ticket `done`: merge `work/t<id>` to `main`, archive `.task/`, then remove the worktree and branch — in that order, only on a clean merge.
31. As a developer, I want approve to refuse unless my repo root is on `main` and clean, so a merge never clobbers my uncommitted edits (the in-place layout merges in the root working tree).
32. As a developer, I want a merge conflict (or any merge failure) to abort cleanly, leave the ticket in `pending-human-qa`, preserve the worktree, and report — so I resolve manually and re-approve, with iudex never half-applying a merge.
33. As a developer, I want `iudex human-qa reject <id> --reason "..."` to send the ticket back to `active` and append a timestamped "Human QA feedback" section to `.task/review.md`, so the next impl session sees my guidance.
34. As a developer, I want `human-qa reject` to NOT count toward the QA-failure limit, so my own feedback never auto-fails a ticket.

### Recovery and abandonment
35. As a developer, I want `iudex retry <id>` to move a `failed` ticket back to `active` and reset its QA-reject counter, so a fresh agent attempt gets a clean budget in the preserved worktree.
36. As a developer, I want `iudex remove <id>` to abandon a ticket from any non-terminal state (queued, active, pending-qa, pending-human-qa, failed) → `removed`, archiving `.task/` and removing the worktree if one exists, so there's always one clean way to kill a ticket.

### Status and visibility
37. As a developer, I want `iudex status` to group tickets under state headings (QUEUED/ACTIVE/PENDING-QA/PENDING-HUMAN-QA/FAILED) in a single print, so I see the pipeline at a glance without a TUI.
38. As a developer, I want queued tickets annotated `ready` or `blocked by: <deps + states>`, so I instantly know what I can activate.
39. As a developer, I want failed tickets to show their rejection count, and `done`/`removed` hidden unless I pass `--all`, so status stays focused on live work.

### Spawn commands
40. As a developer, I want `iudex spawn [id]` to print the correct spawn command for the ticket's current state (impl when active, QA when pending-qa), inferring the ticket from cwd when inside a worktree, so I can re-fetch the command anytime.
41. As a developer, I want spawn commands built from `agent_command` and the prompt templates in `.iudex/prompts/`, and I want iudex to never launch an agent itself, so iudex stays agent-agnostic and I keep control.

### Archive
42. As a developer, I want every `done`/`removed` ticket archived at `.iudex/archive/t<id>/` with `brief.md`, `log.md`, `review.md`, `diff.patch` (final diff vs main, excluding `.task/`), and `meta.json` (outcome, timestamps, merge commit if done, qa-reject count, full event history), so the supplementary context survives even though it never lands on `main`.

## Implementation Decisions

- **In-place workspace, everything under a gitignored `.iudex/`.** The existing repo IS the workspace and the canonical `main` worktree. Ticket worktrees live at `.iudex/worktrees/t<id>/` (git resolves a worktree by its `.git` pointer, so nesting inside the repo is fine as long as `.iudex/` is ignored — no recursion, since `work/t<id>` is branched from `main` which never tracked `.iudex/`). Config, prompts, queue, archive, and `events.jsonl` are local-only operational state.

- **Append-only `events.jsonl` is the sole source of truth.** Status is derived by replaying events. Dependencies are stored in the registration event, not parsed from markdown — this structurally eliminates the file-vs-state drift and the TOCTOU dependency bug from the prior design.

- **Seven states, all transitions command-driven.** No background process advances anything.
  ```
  (none) --queue--> queued
  queued --activate[deps all done, under max_active]--> active
  active --finish--> pending-qa
  pending-qa --qa approve--> pending-human-qa
  pending-qa --qa reject [count < limit]--> active
  pending-qa --qa reject [count == limit]--> failed
  pending-human-qa --human-qa approve--> done        (merge + archive + remove worktree)
  pending-human-qa --human-qa reject--> active
  failed --retry [reset counter]--> active
  <any non-terminal> --remove--> removed             (archive + remove worktree if present)
  ```

- **Activation owns worktree + `.task/` setup.** Creates `work/t<id>` off `main_branch`, moves the queue file → `.task/brief.md`, creates `.task/log.md`, ensures `.task/` is gitignored in the worktree. QA later writes `.task/review.md`.

- **Dependency rule: deps must already be registered and still reachable.** `queue` rejects deps that are unregistered, `removed`, or `failed`. Graph is a DAG by construction; no cycle-detection code.

- **QA-reject counter is cumulative and QA-only.** Only `qa reject` increments it; `human-qa reject` never does. Reaching `qa_reject_limit` → `failed` (worktree preserved). `retry` resets the counter.

- **Merge happens in the repo root.** Because git forbids `main` being checked out in two worktrees, approve merges in the root working tree, which must be on `main_branch` and clean. Default `--no-ff` with a `merge_message_template`; configurable to `squash`. Any failure aborts and preserves everything.

- **iudex prints spawn commands, never execs.** On `activate` it prints the impl command; on `finish` (→ pending-qa) the QA command; `iudex spawn` reprints based on current state. Built from `agent_command` + `.iudex/prompts/{impl,review}.md`.

- **cwd-based ticket inference.** Worktree-scoped commands (`finish`, `qa approve/reject`, `spawn`) infer the ticket when run inside `.iudex/worktrees/t<id>/`; an explicit id always overrides. Workspace discovery walks up from cwd for `.iudex/config.yml`, like git finds `.git`.

- **`config.yml` fields:** `main_branch`, `max_active`, `qa_reject_limit`, `agent_command`, `merge_strategy` (`no-ff`|`squash`), `merge_message_template`, `branch_prefix`.

- **All git via `exec.Command`; templates via `//go:embed`.** No libgit2, no network to build or init.

## Testing Decisions

A good test asserts on observable outcomes through a module's external interface, not internal state. Higher seams are preferred. Three seams:

- **CLI binary (highest).** Compile the binary; drive a real git repo in a temp dir through full flows (`init` → author file → `queue` → `activate` → `finish` → `qa approve` → `human-qa approve` → merged/archived). Assert exit codes, stdout, final `events.jsonl` state, worktree presence/absence, branch existence, and archive contents. Also cover: dep-blocked activation refused; `max_active` enforced; `qa reject` ×N → `failed`; `retry` resets; `remove` from each non-terminal state; merge refused when root dirty/off-main; conflict aborts and preserves.
- **events.jsonl state machine.** Drive append/replay directly: state derivation, no-reuse enforcement, dependency-readiness checks against the registered dep set, cumulative counter, malformed-line tolerance, concurrent-append safety.
- **Dependency / queue validation.** Unit-test the `queue` validation logic: rejects reused ids, rejects unregistered/removed/failed deps, accepts empty deps, computes `next-ticket-id` correctly.

Prior art: the existing repo's `events` replay and `queue/deps` packages are close in shape and can seed these, though most logic is being rewritten.

## Out of Scope

- Any background process, daemon, polling loop, ticks, heartbeat, stall detection, or auto-advancing of tickets — **all movement is manual** in v1.
- TUI / live dashboard — replaced by one-shot `iudex status`.
- Auto-claiming queued work, ticket bundling, AI-driven assignment, priority ordering.
- Conflict-resolution tooling — conflicts abort and are resolved manually.
- Remote / multi-machine coordination; sharing iudex state via git (it's local-only).
- Launching agent processes — iudex only prints spawn commands.
- The old `rejected` and `human-manual` states (gone) and the `priority` feature (gone).

## Further Notes

- This is a clean rewrite; the prior PRD and its locked layout are superseded.
- Future versions may add automation (auto-activation of ready tickets, an optional watch loop, concurrency policy) on top of this command-driven core — the point of v1 is to get the rules and state machine right first.
- CLAUDE.md must be rewritten to match this design before/alongside implementation, since the current one documents the superseded architecture.
