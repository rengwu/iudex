# PRD: Resolver-status honesty (GUI)

> Hardened through a grill-with-docs session, 2026-07-07. Pure `gui/` change.
> Companion to `.context/prd/auto-resolve.md`; the shared derivation it
> introduces is the one `gui/src/lib/agents.ts` already sketches as
> `resolveStatus`.
>
> **IMPLEMENTED 2026-07-07** (uncommitted, in the working tree). All decisions
> below are done: `resolveStatusForTicket` wrapper (agents.ts); Review banner +
> header badge morph by status with a spawn-only Re-run on crash; Auto-Resolve
> phase routed through the wrapper; sidebar status span removed; `flagged` rail
> badge via `rail_status` report-read. Verified: `tsc --noEmit` clean, `vite
> build` OK, `cargo check` OK.

## Problem

When a resolve agent finishes what it can — resolves the trivial conflicts,
flags the genuinely ambiguous ones for human judgment (writing
`.task/resolution.json`), then **exits** (the resolver is not a daemon; its
prompt tells it to leave the merge in progress and stop) — the Review tab still
tells the user it is busy:

- The blue banner "◐ Resolver agent working in the worktree…"
  (`gui/src/views/Review.tsx:642`) renders whenever `resolverActive` is true,
  and `resolverActive` is just `!!resolver` — "a session with `role: "resolve"`
  for this ticket still exists" (`Review.tsx:90-93`). A dead/exited pane still
  exists, so the banner claims "working" for the agent's entire life.
- The "◐ resolving" badge on the ticket header (`Review.tsx:802`) and on every
  rail card (Rust `rail_status`, `gui/src-tauri/src/lib.rs:2218`) keys purely
  off `MERGE_HEAD` existing. A flagged-but-uncommitted merge is still in
  progress, so it reads "resolving" indefinitely too.

The user cannot tell "still working" from "done — your turn" without opening the
agent console via Watch. The information already exists — `resolveStatus`
(`gui/src/lib/agents.ts:84`) derives the true state and the **Agents** panel
shows it correctly — it is simply never plumbed into Review.

### Root cause: three separate answers to one question

Three surfaces each independently answer "what is the resolver doing?", and they
can disagree about the same ticket at the same moment:

| Surface | Today | How it decides |
| --- | --- | --- |
| Agents panel | correct | `resolveStatus()` — `flagged.some(f => f.reason) \|\| dead` |
| Review banner + badges | wrong | session-exists / `MERGE_HEAD`-exists |
| Auto-Resolve transport row (`gui/src/lib/automation.ts:360-378`) | own copy | `res.hasReport && res.flagged.length > 0` |

The Auto-Resolve copy uses a *different* flagged test than `resolveStatus`, so
the sidebar "your turn" line can disagree with what Review (once fixed) and the
Agents panel show — e.g. a report that lists only *resolved* files while git
still shows an unmerged file with no reason: Auto-Resolve calls that "flagged",
`resolveStatus` calls it "working" (if the agent is still alive).

## Decisions

1. **One shared derivation for "what state is the resolver in".** Generalize
   today's `resolveStatus` into the single source consumed by all three display
   surfaces: the **Review banner + header badge**, the **Agents panel**, and
   **Auto-Resolve's transport-row label**. It returns
   `working / idle / flagged / crashed / resolved` from process liveness
   (dead/exit) + the `read_resolution` report, exactly as
   `resolveStatus` does today (`flagged.some(f => f.reason) \|\| dead`). This
   kills display divergence at the root.

   - **Signal choice (why liveness, not just the report):** the resolver
     flags-then-exits, so "report written" and "process exited" normally
     coincide. The report-only test (`flagged.some(reason)`) misses exactly one
     case — the agent **crashes before writing its report** — which would leave
     the same misleading "working" banner for that failure mode.
     `flagged.some(reason) || dead` covers both.

   - **"flagged" requires a non-empty unmerged set.** `resolution.flagged`
     mirrors git's unmerged files, so the flagged test is
     `flagged.length > 0 && (flagged.some(reason) || dead)`. Without the length
     guard, the moment the human resolves the **last** flagged file (unmerged set
     empties, merge not yet committed) a dead resolver still reads "flagged" via
     `|| dead` — the banner and header badge reappear with nothing to do but
     Commit. Instead, merge-in-progress + empty unmerged set + dead agent →
     **`resolved`** (its work is done; only the human's commit remains). The
     banner hides on `resolved`; the header stays "◐ resolving" (merge still
     open); Auto-Resolve shows no line for it (decision 2 maps `resolved → no
     row`); the rail requires an actual git-unmerged file (not just the stale
     `resolution.json`) before it says "flagged".

   - **Shape: core primitive + per-ticket wrapper.** Keep the existing
     `resolveStatus({dead, exitCode, ticketState, quietMs, resolution})` as the
     single derivation primitive (Agents keeps calling it *per session*). Add a
     thin **per-ticket** wrapper — `resolveStatusForTicket(resolveSessions,
     statsByName, resolution, ticketState)` — that aggregates liveness across
     *all* of a ticket's resolve sessions (any pane not-dead ⇒ `dead:false`;
     else if any exited non-zero ⇒ crashed), then calls `resolveStatus` once.
     **Review and automation use the wrapper**; Agents stays per-session. Two
     reasons this shape is required, not cosmetic:
     - **R2:** Review's current `sessions.find(role==="resolve")`
       (`Review.tsx:90`) returns the *first* match; after a Re-run there are two
       sessions (stale-dead + new), so `find` can return the dead one and show
       "crashed" while the new agent works. Aggregating across all of the
       ticket's resolve sessions fixes this.
     - **R3:** `useSessions` carries no liveness — `dead`/`exitCode` come only
       from `api.sessionStatuses()`. The wrapper takes that `statsByName` map as
       input. In Review, source it by fetching `sessionStatuses()` inside the
       existing 3s merge-poll (`Review.tsx:112-114`) and holding it in state —
       no new always-on loop. `quietMs` is irrelevant here (idle folds into
       working, decision 3), so pass `0`.

2. **Auto-Resolve keeps its own "should I act?" policy, layered on top.** The
   inline branches at `automation.ts:360-400` do a second job the shared
   function does not: decide whether the *engine* should act (the
   `autoBegunRef` / `resolveHandledRef` one-at-a-time bookkeeping, and the
   "MERGE_HEAD with no report and not auto-begun = the human's own merge → hands
   off" branch). That policy stays. Only the *phase label* it surfaces
   (`resolving / flagged / crashed`, the `ResolveStatus` returned by the hook) is
   re-derived from the shared function, so the phase can never disagree with
   Review. Map: `working|idle → resolving`, `flagged → flagged`,
   `crashed → crashed`; `resolved → no row` (all conflicts resolved, only the
   human's commit remains — not a parked error and not the engine's job);
   `done` ends the episode. The human-merge hand-off branch is unchanged.

   > Behavioral note: aligning the phase to `flagged.some(reason)||dead` subtly
   > changes when Auto-Resolve considers a ticket "flagged" in the
   > report-without-a-reason edge case above. This is intended — it makes the
   > phase agree with Review — but call it out in the implementing ticket so it
   > isn't mistaken for a regression.

2a. **Drop the resolver-phase status from the sidebar Auto-Resolve row.** Today
   the Auto-Resolve toggle row shows an inline "· tN {phase}" status
   (`Sidebar.tsx:199-213`, styled `resolveBusy`/`resolveParked`). Remove it: the
   row reverts to a plain label + toggle like Auto-Activate/Auto-QA/Auto-Retire.
   The same "your turn" information still surfaces on the **Dashboard**
   ("Resolution {phase} on tN — your turn", `home.ts:47-53`, `Dashboard.tsx:511`),
   which is the cross-view nudge — so nothing is lost. Decision 2's consolidation
   therefore still matters: the Dashboard line must agree with Review.

   Scope is tight — this is the sidebar's *display* only:
   - Remove the `{resolveStatus && (…)}` span (`Sidebar.tsx:199-213`) and the
     `resolveStatus` entry from the component's destructure.
   - Remove the now-unused `.resolveBusy` / `.resolveParked` rules in
     `Sidebar.module.scss`.
   - **Do NOT** remove `resolveStatus` from the `Automation` type
     (`Sidebar.tsx:16-28`) or the `ResolveStatus` import — the Dashboard consumes
     the same hook return through that type. No `App.tsx` call-site change (it
     passes the whole `automation` object, not a discrete prop).

3. **The Review banner morphs by state** (was: always "working" while a resolve
   session exists). `ReviewPane` computes the shared status **once** and feeds
   both the banner and `headerBadge` so they cannot drift:

   | status | banner label | buttons |
   | --- | --- | --- |
   | working / idle | ◐ Resolver working in the worktree… | Watch · Stop · Re-check |
   | flagged | ◑ Resolver finished — flagged N for you | Watch · Re-check |
   | crashed | ⚠ Resolver crashed — conflicts left | Watch · **Re-run resolver** · Re-check |

   - `idle` (alive but quiet >5s, no report) **folds into "working"** — no
     distinct "may be stuck" copy (rejected: false-alarm risk on an agent that
     is simply thinking).
   - `Stop` is **dropped** once the agent has exited (flagged/crashed) — it
     implied something was running when nothing is.
   - `crashed` gains a **Re-run resolver** action. **R1:** it must NOT reuse
     `resolveWithAgent`, which calls `beginResolution` — that hard-errors with
     "a merge is already in progress" (`lib.rs:1782`) because a crashed agent
     leaves `MERGE_HEAD` set. Re-run is a dedicated **spawn-only** handler:
     `api.spawnResolver(root, selId, worktree)` then `recheck()`, no begin.
   - `resolved` needs no banner: `mergeInProgress` is then false, so the tab is
     already on the ready/all-resolved path, not this branch.

4. **Badges get a "flagged / needs you" value** (was: "resolving" whenever
   `MERGE_HEAD` exists). The header/rail vocabularies stay unified
   (`Review.tsx:797`).

   - **Header badge** (open ticket) — driven by the shared status (decision 1),
     so it matches the banner: `resolving` / `flagged` (⚠ needs you) /
     `crashed`.
   - **Rail badge** (every pending-human-qa card) — stays a **coarse**
     sequencing hint and stays in Rust. `rail_status` adds the new value from a
     cheap `.task/resolution.json` read (reusing the existing `Report` struct,
     `lib.rs:1831`): while a merge is in progress, a report with ≥1 flagged entry
     that carries a non-empty `reason` → "flagged" (mirrors the core
     `flagged.some(reason)`); otherwise "resolving". **No tmux.** Accepted gap: a
     crash-before-report card still reads "resolving" on the rail, because the
     rail has no liveness signal; opening the card shows the true state via the
     banner (decision 3). Full per-card liveness in Rust was rejected as
     heaviest and a re-implementation of logic the frontend already owns.

## Non-goals

- No CLI or `iudex` binary changes — this is entirely GUI display consistency.
- No change to the resolver prompt or its flag-then-exit contract.
- No change to Auto-Resolve's act/park/hand-off *policy* (only its label
  source).
- No new always-on poll loop (reuse Review's existing 3s merge-poll).

## File map

| File | Change |
| --- | --- |
| `gui/src/lib/agents.ts` | Keep `resolveStatus` as the per-session primitive (Agents unchanged). Add `resolveStatusForTicket(resolveSessions, statsByName, resolution, ticketState)` — aggregates liveness across the ticket's resolve sessions, calls `resolveStatus` once. |
| `gui/src/views/Review.tsx` | `ReviewPane`: fetch `sessionStatuses()` in the existing 3s merge-poll → state; compute the ticket status via `resolveStatusForTicket` over all resolve sessions for `selId` (replaces the single `find` at :90 for status purposes). Pass the status to `ConflictsTab` (replace `resolverActive={!!resolver}`) and to `headerBadge`. Banner: state table; add a **spawn-only** `rerunResolver` handler (R1); drop Stop when exited. `headerBadge`: add `flagged`/`crashed`. |
| `gui/src/lib/automation.ts` | Re-derive the `ResolveStatus` `phase` from the shared function (map working/idle→resolving, flagged→flagged, crashed→crashed); keep the `autoBegunRef`/one-at-a-time/human-merge policy branches. |
| `gui/src/components/Sidebar.tsx` | Remove the `resolveStatus` status span from the Auto-Resolve row + its destructure (decision 2a). Keep the `Automation` type's `resolveStatus` field and the import (Dashboard uses them). |
| `gui/src/components/Sidebar.module.scss` | Remove the now-unused `.resolveBusy` / `.resolveParked` rules. |
| `gui/src-tauri/src/lib.rs` | `rail_status`: when `MERGE_HEAD` is set, read `.task/resolution.json`; emit `flagged` (report + ≥1 flagged file) vs `resolving`. Update the `RailCard.badge` doc-comment enum. |
| `gui/src/types.ts` | Widen the rail badge union to include the flagged value. |
| `gui/src/lib/badges.ts` + `gui/src/views/Review.module.scss` | Style for the new "flagged / needs you" badge (amber, matching the Review conflict amber `#e6b54c`); reuse `railBadge`/`headerBadge` vocabulary. |

## Edge cases to verify

- Agent flags then exits → banner "finished — flagged N", header + rail badges
  "flagged", Auto-Resolve row "flagged". All three agree.
- Agent crashes before writing a report → banner "crashed" with Re-run; header
  badge "crashed"; **rail badge reads "resolving"** (accepted coarse gap).
- Agent still actively working → "working" everywhere; Stop present.
- Human began the merge by hand (no resolve session) → no banner (unchanged;
  `resolverActive` false); Auto-Resolve hands off (unchanged).
- Merge committed / aborted → `mergeInProgress` false → ready path; no banner.
- Human resolves the last flagged file (unmerged set empty, not yet committed)
  → status `resolved`: **no banner**, header "◐ resolving", rail "resolving",
  no Auto-Resolve line. The only CTA is the "✓ All conflicts resolved — commit"
  box. (Regression guard: the banner must not reappear here.)
