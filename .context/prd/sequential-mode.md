# PRD: Sequential mode + auto-advance (GUI)

> Hardened through a grill-me session, 2026-07-03. Phase 1 #2 of the launch
> plan (`docs/launch-plan.md`): the calm first-run mode — one ticket at a time,
> plumbing automated, gates human.

## Problem

The pipeline's per-ticket ceremony is ~7 human steps, and parallel worktrees
intimidate newcomers. The GUI already has an opt-in automation engine
(`gui/src/lib/automation.ts`: Auto-Activate / Auto-QA / Auto-Retire, session
-only), but (a) there is no way to say "one thing at a time", (b) tickets
rejected back to `active` sit agentless until someone notices, and (c) the
auto-activate drain permanently parks a ticket whose `activate` failed — which
includes the transient "at max_active cap" failure.

## Decisions (each resolved explicitly)

1. **Sequential = strict one-in-flight.** In-flight means
   `active | pending-qa | pending-human-qa`. Nothing new activates until the
   line is empty. `failed` is **not** in flight — it is a parked human decision
   (`retry`/`remove`), and blocking the line on it would deadlock the pipeline
   on its least-productive member. Rejected alternative: pipelined ("one
   implementing, QA overlaps") — higher throughput but recreates the
   several-tickets-at-your-gate chaos sequential exists to remove.
2. **Hard policy, always in force.** Sequential blocks *all* GUI activation —
   the autopilot drain *and* the manual Activate action (disabled with an
   honest hint naming the in-flight ticket). It applies even when the engine
   toggles are off: it is a workspace property, not an autopilot flag. The CLI
   can always bypass (the GUI cannot and should not police it) — the hint keeps
   that honest.
3. **Keep the three toggles; Sequential is a fourth, persisted switch** in the
   sidebar transport. Rejected alternative: a Manual/Sequential/Parallel
   tri-state replacing the toggles.
4. **Persist the policy, never the engine.** `gui_sequential: true|false` in
   the workspace `.iudex/config.yml` (the CLI's YAML parsing ignores unknown
   keys — verified; matches the `gui_*` precedent in the global config). The
   engine toggles stay session-only so opening the app can never silently
   spend tokens.
5. **Auto-Activate absorbs respawn-on-reject.** While on, it (a) activates
   ready queued tickets and (b) spawns an impl agent for any `active` ticket
   without a live impl session — which is exactly the state a `qa reject` or a
   `human-qa reject --reason` leaves behind. Both rejects respawn: the QA loop
   is capped by `qa_reject_limit`, and a human reject's written reason is
   precisely what the next impl run consumes. Guard: never spawn when a live
   impl session exists.
6. **Turn-on with work in flight drains naturally** — no kills, autopilot just
   won't start anything new until the line empties.
7. **Crashes notify only** (the Agents view already synthesizes "crashed"); no
   auto-respawn-on-crash in v1 — no spawn loops on a systematically failing
   command.
8. **Ordering:** autopilot activates the first ready ticket in registration
   order (`to-issues` registers in dependency order, so this is the intended
   sequence).
9. **Bug fix (independent of mode):** the drain must treat "no slot" (cap or
   sequential gate) as *pause this pass*, not park-the-ticket-forever; the
   skip-set is only for real per-ticket failures.

## Out of scope

Dashboard mode controls (Phase 1 #3 surfaces the same state there), CLI
awareness of the policy, auto-retry of `failed`, crash auto-respawn.
