# PRD: Auto-Resolve conflicts (GUI automation toggle)

> Hardened through a grill-me session, 2026-07-03. Companion to
> `.context/prd/sequential-mode.md`; extends the automation engine in
> `gui/src/lib/automation.ts`.

## Problem

A `pending-human-qa` ticket whose merge preflight predicts conflicts sits
unmergeable until someone clicks Begin-resolution and spawns the resolve agent.
The resolver already exists and already flags-instead-of-guesses; the only
missing piece is the automation that runs it *before* the human sits down —
so the front of the review queue is always mergeable.

## Decisions

1. **A separate, individually-armed engine toggle** — deliberately NOT armed
   by the transport's play button (rejected: full engine membership). It is
   the one toggle that spends tokens with no human click between qa-approve
   and review, so arming it is its own explicit act. Like the other engine
   toggles it is session-only and resets on workspace switch; disclosure is a
   tooltip (spawns a resolve agent when a review-ready ticket has conflicts;
   up to one more run each time main moves) — no confirmation dialog.
2. **Candidate: the first `pending-human-qa` ticket in registration order
   whose preflight predicts conflicts** (clean ones are skipped past). Matches
   auto-activate's ordering; oldest-first also minimizes re-resolution churn.
   Manual Begin-resolution in Review covers "this other one first".
3. **Strictly one resolution at a time.** While the candidate is being
   resolved, or is parked (flagged / crashed), automation does not touch any
   other conflicted ticket. Parallel half-resolved worktrees are the chaos
   this feature exists to remove.
4. **Parked states halt the line and surface on the transport row.** Resolver
   flagged files → "your turn" (the merge stays in progress for the human, by
   the resolver's design). Resolver crashed (dead session, non-zero exit) →
   notify-only, same as the impl-crash policy — never respawn into a possibly
   poisoned merge. The Auto-Resolve row doubles as status (e.g. "t3 flagged")
   so the wait is visible from every view; Review keeps the detail.
5. **Hands off merges automation didn't start.** MERGE_HEAD set with no live
   resolve session and no resolver report = the human's manual resolution —
   the engine skips the ticket entirely (and, per #3, waits).
6. **Auto re-fire per merge.** Episode guards clear whenever the workspace's
   done-count changes: a sibling merge moves main, the candidate's preflight
   is re-run, and a fresh *incremental* resolution pass (merge new main into
   the worktree) fires unattended. Strict serial bounds spend at one resolver
   run per merge — O(merges) total.
7. **Reject aborts a half-merge — unconditionally, toggle or no toggle.**
   `human-qa reject` with MERGE_HEAD set leaves a half-merged worktree that
   the (new) auto-respawned impl agent would land in. Review's reject now
   runs `abort_resolution` first whenever a merge is in progress. This is a
   standalone fix for a latent trap that predates the toggle (rejected:
   prompting — there is no sane "keep the half-merge" answer).

## Out of scope

Auto-merge after a fully-resolved pass (the human gate is the product),
resolving more than one ticket concurrently, CLI awareness, retry caps beyond
the parked states (spend is already bounded by #6).
