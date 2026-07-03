# PRD: Dashboard — the home view

> Grilled 2026-07-03. Phase 1 #3 of `docs/launch-plan.md`. Replaces the old
> removed "glanceable router"; becomes the app's default landing view.

## Job statement

Open the app cold → within two seconds know the state of the line and the
single next thing worth doing. Glance first; control, navigation, and
starting new work second.

## Zones & decisions

1. **NOW (hero)** — one big state-colored CTA + two runner-up links, from a
   pure, single-sourced `workspaceNextAction(...)` ranking (the workspace-level
   sibling of `nextAction`). **Problems first, then the gate** (decided): parked
   resolution (flagged/crashed) → crashed agents → pending-human-qa → failed →
   rejected-back actives with no impl agent → unstaffed pending-qa → ready
   queued (sequential-gated) → idle ("line clear — shape an idea"). Rationale:
   broken things rot silently; review items already announce themselves via
   the nav count. Hero CTAs *navigate* (to the focused view) rather than
   execute — the target view holds the action button and its busy/error
   plumbing.
2. **PIPELINE** — the state machine as five dense columns (queued → active →
   QA → review → merged) with clickable chips: **id + brief title + status
   hint** (decided; capped per column with +N overflow). Hints: `ready`/`⊘dep`
   on queued, live-agent dot on active/QA, preflight clean/conflicts badge on
   review (via `rail_status`). Read-only + navigational — the Tickets board
   keeps selection/actions; this is the glance (and the launch screenshot).
3. **START** — the funnel's front door, **inline** (decided; not a door to the
   Tickets modal): seed textarea + skill select (default grill-me) → spawns
   the idea agent and jumps to its console. Plus compose-ticket (→ Tickets)
   and open-shell (→ Terminal) links.
4. **AUTOMATION** — the roomy version of the sidebar transport (same
   `useAutomation` state, zero state duplication): mode switch
   (Parallel|Sequential), engine toggles, Auto-Resolve status line.
5. **ACTIVITY** — tail of `events.jsonl`, newest first, human-rendered
   ("t5 merged · 1h ago"). **In scope now** (decided): a small display-only
   Rust read (`recent_events`) returning verbatim ticket/from/to/trigger/ts —
   rendering the log is not re-deriving state, so the no-Derive-in-GUI
   invariant holds. Refreshes on the doorbell like everything else.

Default landing view flips from Tickets to Dashboard.

## Out of scope

Executing pipeline actions from the hero (navigate-only in v1), a mini-kanban
with inline actions (that's the Tickets board), event-log filtering/search,
remote-compose (opening the Tickets compose modal from here).
