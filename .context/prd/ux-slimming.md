# UX Slimming — Execution PRD

> **Status:** approved for implementation, 2026-07-04.
> **Audience:** the implementing agent. This document is self-contained — every rule,
> regex, and wording you need is embedded here; you never need to consult deleted code.
> **Base:** branch `feat/gui-packaging` (surveyed at commit `7fc248d`). All line numbers
> in this document are survey hints — **always locate code by symbol/grep, never by line
> number.**
> **Ground rules:** do not touch anything outside the changes specified here. Match the
> surrounding code's style and comment density. Run the verification steps of a part
> before committing it. One commit per part (suggested messages given). Do not add any
> Co-Authored-By or AI attribution to commits.

## Background (context for the implementer)

iudex is a Go CLI orchestrating AI coding agents across git worktrees (see `CLAUDE.md`).
The Tauri GUI in `gui/` holds no authoritative state: it reads via `iudex … --json`,
writes by shelling the CLI, and owns only agent process supervision (a tmux pool).

A UX review produced three decisions:

1. **Remove the `iudex spec` CLI command.** The `REQ-N` heading convention in
   `.context/prd/*.md` and the GUI's Specifications view **stay**. Parsing/linting moves
   into the GUI (it is a document-display concern, not state-machine logic — the
   "never reimplement Derive" invariant does not apply). Id numbering moves into the
   work-shaping skills as an explicit grep-derived rule: **derive the next id, never
   store a counter** (same principle as `iudex next-ticket-id`).
2. **Worktrees view** gains (a) an "N uncommitted" dirty badge per rail entry including
   the pinned main root, and (b) orphaned-worktree detection with a guarded Remove
   action. An orphan is the residue of best-effort cleanup: a physical worktree whose
   ticket is terminal (`done`/`removed`) or unknown.
3. **Auto-Retire becomes "marked for death".** Keep the toggle but default it **ON**;
   instead of killing a superseded agent instantly, stamp a retire deadline on its tmux
   session, show a countdown chip + a **Keep** (pardon) button in the Agents view, and
   kill past-due sessions on a sweep. Grace period is a global setting
   `gui_retire_grace_minutes` (default **10**, `0` = kill immediately). Kills happen on
   schedule even if the user is viewing the console (explicit product decision).
   Toggling the engine OFF clears all pending marks — disarm means nothing dies.

---

## Part A — remove `iudex spec`; keep the Specifications view

### A1. Delete the Go surface

1. Delete `internal/cmd/spec.go`, `internal/spec/spec.go`, `internal/spec/spec_test.go`,
   and `spec_cli_test.go` (repo root).
2. In `internal/cmd/root.go`, remove `newSpecCmd()` from the command registration list
   (survey hint: line 50).
3. Keep `workspace.PRDDir` (`internal/workspace/workspace.go`) — the GUI's `read_prd`
   still uses that path convention.

### A2. Port the parser + lint into the GUI (TypeScript)

Create `gui/src/lib/spec.ts` exporting `parsePrd(file: string, content: string): PRD`
and `lintPrd(content: string): LintWarning[]` where
`LintWarning = { line: number; message: string }` (1-indexed lines). The types
`PRD`/`Requirement`/`SpecDoc` in `gui/src/types.ts` (~lines 28–43) are **unchanged**:
`Requirement { id, title, status, body }`, `PRD { file, title, requirements }`,
`SpecDoc { prds }`.

**Parsing rules (complete — a faithful port of the deleted Go parser):**

- Normalize line endings: split on `\n`, strip a trailing `\r` from each line.
- **Heading:** a line matching `/^(#{1,6})\s+(.*)$/`. Level = number of `#`; heading
  text = capture 2, trimmed.
- **PRD title:** the first level-1 heading's text sets `PRD.title` (only if title is
  still empty). `PRD.file` = the basename passed in.
- **Requirement heading:** a heading whose trimmed text matches
  `/^REQ-(\d+|\?):\s*(.*\S.*)$/` (any heading level 1–6). Capture 1 is digits or `?`;
  `id = "REQ-" + capture1`; `title = capture2.trim()` (the regex already requires a
  non-space char). Default `status = "active"`.
- **Meta lines:** immediately after a requirement heading, consume consecutive lines
  matching `/^>\s*([A-Za-z][\w-]*):\s*(.*)$/`; stop at the first non-matching line.
  If the key equals `status` case-insensitively, set `status = value.trim()` — store
  the raw value even if it isn't in the vocabulary (the view's `statusStyle` already
  falls back for unknown values). Other meta keys are allowed and ignored.
- **Body:** all lines after the meta block until the next requirement heading OR any
  heading whose level is ≤ the requirement's own level. Deeper non-requirement headings
  are part of the body. `body = lines.join("\n").trim()`.
- Non-requirement headings and stray prose are ignored (no requirement open) or belong
  to the current body. The parser **never throws**; `requirements` is always an array.

**Lint rules (all warnings; check every heading whose trimmed text starts with `REQ-`):**

| Condition | Message (exact) |
| --- | --- |
| starts with `REQ-` but doesn't match the requirement regex | `malformed requirement heading "<text>" — expected 'REQ-<n>: <title>'` |
| id is `REQ-?` | `unresolved placeholder REQ-? — assign the next id (see the to-prd skill's numbering step)` |
| numeric id already seen in this file | `duplicate REQ-<n> (first defined at line <m>)` |
| a `status` meta value not in `active`/`parked`/`out-of-scope` | `unknown status "<v>" — expected active, parked, or out-of-scope` |

**Fixture (use to verify the port by hand or in a test if a test runner exists — do not
add a test framework just for this):**

```markdown
# Payments PRD

Intro prose.

### REQ-1: Card payment via Stripe
> status: active
> owner: jane

Body line A.

#### Sub-detail heading

Body line B.

### REQ-?: Gift receipts
> status: parked

## Non-requirement section
```

Expected: `title: "Payments PRD"`; requirement 1 = `{id: "REQ-1", title: "Card payment
via Stripe", status: "active", body: "Body line A.\n\n#### Sub-detail heading\n\nBody
line B."}`; requirement 2 = `{id: "REQ-?", title: "Gift receipts", status: "parked",
body: ""}` (the `## Non-requirement section` heading, level 2 ≤ 3, closes the body).
Lint yields exactly one warning: the unresolved-placeholder message on the `REQ-?` line.

### A3. New Rust command `list_prds`

In `gui/src-tauri/src/lib.rs`, next to `read_prd` (survey hint: ~line 890):

```rust
#[tauri::command]
fn list_prds(root: String) -> Result<Vec<String>, String>
```

- Read the directory `<root>/.context/prd`; a missing directory returns `Ok(vec![])`.
- Collect **file** entries (not dirs) whose name ends in `.md`, return basenames sorted
  ascending.
- Follow the file's existing error style (map io errors to `e.to_string()`).
- Register `list_prds` in the `tauri::generate_handler![…]` block next to `read_prd`
  (survey hint: ~line 2224).

### A4. Rewire the GUI read path

- `gui/src/lib/api.ts` (~lines 86–89): **delete** `specJson` (it shells
  `runIudex(root, ["spec", "--json"])`). Add
  `listPrds = (root) => invoke<string[]>("list_prds", { root })`. Keep `readPrd`.
- Add a composer (in `gui/src/lib/spec.ts` or api.ts):
  `loadSpec(root): Promise<SpecDoc>` = `listPrds`, then for each file
  `readPrd(root, file)` → `parsePrd(file, content)`, preserving the sorted order;
  return `{ prds }`.
- `gui/src/views/Specifications.tsx`: replace the `api.specJson(root)` load with
  `loadSpec(root)`. Add lint display: when the selected PRD's raw markdown is loaded
  (the existing `readPrd` call feeding MdViewer), run `lintPrd(raw)` and render any
  warnings as a compact amber list ("line N: message") above the requirements list in
  the right pane — reuse the existing `Badge`/typography idioms; keep it quiet when
  there are no warnings. Update the comment block that references `iudex spec --json`
  (structure is now parsed in the GUI) and any empty-state copy that mentions the CLI.

### A5. Rewrite the skills (numbering becomes self-contained)

**`templates/dot_iudex/skills/to-prd/SKILL.md`:**

1. Replace step 4 ("Normalize & self-check the requirement ids. Run `iudex spec lint
   --fix` …") with **exactly**:

   ```markdown
   4. **Number the requirement ids.** Ids are scoped to this one file — other PRDs'
      numbers are irrelevant. Do this as a final pass, never while drafting:
      a. Find the highest id already in the file:
         `grep -oE 'REQ-[0-9]+' .context/prd/<slug>.md | grep -oE '[0-9]+' | sort -n | tail -1`
         If there is no match, the highest is 0.
      b. Replace each `REQ-?` placeholder with the next integer, in the order the
         placeholders appear in the file: the first gets highest+1, the next
         highest+2, and so on.
      c. Hard rules: NEVER renumber or reuse an id that already has a number, even
         if its requirement is out-of-scope or struck through. NEVER restart at 1
         when editing an existing PRD. NEVER leave a `REQ-?` in the finished file.
      d. Verify: `grep -c 'REQ-?' .context/prd/<slug>.md` must print 0, and
         `grep -oE 'REQ-[0-9]+:' .context/prd/<slug>.md | sort | uniq -d` must print
         nothing (no duplicate ids). Fix and re-verify if either check fails.
   ```

2. In the "Requirement format" section (survey hints: lines 16–20):
   - "surfaced by `iudex spec` and the GUI's Specifications view" → "surfaced by the
     GUI's Specifications view".
   - Replace "let the CLI mint the real, file-scoped id in the self-check step" with
     "assign real, file-scoped ids in the numbering pass (step 4)". Keep the
     "**Never hand-number**" sentence.
   - Replace "`iudex spec lint` is the canonical definition of the format — when in
     doubt, run it rather than guessing" with "this section and the numbering pass
     (step 4) are the canonical definition of the format".

**`templates/dot_iudex/skills/to-issues/SKILL.md`** — in step 1 ("Gather context"),
replace the sentence that runs `iudex spec lint --fix … then iudex spec …` with
**exactly**:

```markdown
If the source is a PRD, make sure every requirement has a stable id first: list them
with `grep -nE '^#{1,6} +REQ-' .context/prd/<slug>.md`. If any heading still reads
`REQ-?`, assign ids using the to-prd skill's numbering rule (file-scoped: highest
existing `REQ-<n>` in this file + 1, in order of appearance, never renumbering existing
ids), then re-run the grep to confirm no `REQ-?` remains. Reference those `REQ-N` ids
when you slice, so each ticket traces back to the requirements it satisfies.
```

### A6. Docs

- `grep -rn "iudex spec" README.md CLAUDE.md templates/agents_section.md docs/` and
  remove/reword every reference to the **command** (the `(spec)` pipeline label meaning
  "the PRD artifact" stays). In `CLAUDE.md`, if the CLI commands table lists `spec`,
  remove the row and fix the command count.
- Append to `.context/prd/specifications.md` a dated status note (top of file, blockquote):

  ```markdown
  > **Status note (2026-07-04):** the `iudex spec` CLI command (parser, lint, --fix) has
  > been removed. The `REQ-N` heading convention and the GUI Specifications view remain.
  > Parsing and lint moved into the GUI (`gui/src/lib/spec.ts` — a display concern, not
  > state-machine logic); id minting moved into the to-prd skill as an explicit
  > grep-derived numbering pass (file-scoped max+1, append-only). Rationale: the CLI
  > stays minimal and pipeline-only; ids are derived, never stored.
  ```

### A7. Verify & commit

- `go build -o iudex . && go test ./...` green; `./iudex spec` reports an unknown
  command.
- `cd gui && pnpm build` (or the repo's typecheck script) passes. In `pnpm tauri dev`:
  Specifications lists PRDs and renders titles/requirements/status chips exactly as
  before; temporarily add a malformed `### REQ-x: bad` heading to a scratch PRD and
  confirm a lint warning renders; revert the scratch edit.
- Manually run the step-4 grep commands from A5 against `.context/prd/specifications.md`
  to confirm they behave as written.
- Commit: `feat!: remove iudex spec — parsing to GUI, numbering to skills`

---

## Part B — Worktrees: dirty badges + orphan detection

Files: `gui/src/views/Worktrees.tsx`, `gui/src/lib/worktrees.ts`,
`gui/src/lib/api.ts`, `gui/src-tauri/src/lib.rs`.

### B1. "N uncommitted" dirty badge

- **Backend: none needed.** Reuse `worktree_dirty_count` (lib.rs, survey ~1354–1374:
  `git -C <worktree> status --porcelain`, counting lines whose path doesn't start with
  `.task/`) via the existing `api.worktreeDirtyCount`. Numbers therefore agree with the
  finish-guard confirm by construction.
- **Poll (view-scoped, matching the local `treeReload` precedent — do NOT build an
  app-wide store):** in `Worktrees.tsx`, a `useEffect` keyed on the worktree path list:
  fetch counts for **every** rail entry (the pinned main entry's `path` is the repo
  root — include it; a dirty root pre-explains `human-qa approve` refusals), store as
  `Record<string, number>`, refresh on a ~4s `setInterval`, skip ticks while
  `document.visibilityState === "hidden"`, clear the interval on unmount, and re-fetch
  immediately when the worktree list changes. Swallow per-path errors (a vanished
  worktree mid-poll is normal).
- **Render:** in the rail button's `s.badges` span (survey ~197–214), append — **outside
  the existing three-way ternary**, so it appears on main / no-ticket / ticketed rows
  alike — a quiet amber `Badge` reading `N uncommitted`. Render nothing when the count
  is 0 or unknown. Follow the existing Badge usage in this file for styling.

### B2. Orphaned worktrees + Remove

- **Detection** (a small pure helper in `worktrees.ts` or the view): for each non-main
  worktree, if `w.path` is under `<root>/.iudex/worktrees/` and its basename matches
  `/^t\d+$/`, look up that ticket id in `ws.tickets`. **Orphan ⇔ the ticket is missing
  or its state is `done` or `removed`** (same predicate shape as `isTerminal` in
  `TicketDetail.tsx`, survey ~418). Do **not** rely on the existing
  `t.worktree === w.path` join for this — terminal tickets may no longer carry a
  worktree path. Worktrees outside `.iudex/worktrees/` keep today's "no ticket" badge
  and are never flagged or removable.
- **Render:** an "orphaned" badge on the rail row (use the danger/amber idiom from
  `lib/badges.ts`), and in the detail header a single plain sentence, e.g.
  `t3 is done — cleanup didn't complete.` (or `…has no ticket record.` when the id is
  unknown).
- **Backend:** new command in `lib.rs`, following the file's inline-`Command` pattern
  (`git`, check `status.success()`, else return trimmed stderr):

  ```rust
  #[tauri::command]
  fn remove_worktree(root: String, path: String, force: bool) -> Result<(), String>
  ```

  - Safety guard: canonicalize and require `path` to be under
    `<root>/.iudex/worktrees/`; refuse otherwise (`"refusing to remove a worktree
    outside .iudex/worktrees"`).
  - Run `git -C <root> worktree remove [--force] <path>` — from the **main repo root**
    (worktree removal must run there), like `list_worktrees` does.
  - Register in `generate_handler!` next to the other worktree commands (survey ~2237).
  - `api.ts`: `removeWorktree = (root, path, force) => invoke("remove_worktree", { root, path, force })`.
- **UI flow** ("Remove worktree", `Button variant="danger" size="sm"`, shown only for
  orphans, in the detail head tools):
  1. Try `removeWorktree(root, path, false)`.
  2. On failure, get `n = worktreeDirtyCount(path)`. If `n > 0`, gate on
     `window.confirm(`${n} uncommitted files will be permanently lost. Remove anyway?`)`
     — same lightweight pattern as `finishGuarded` in `TicketDetail.tsx` (survey
     ~423–441) — then retry with `force: true`. If `n === 0`, surface the error text.
  3. **No doorbell fires for this** (nothing writes events.jsonl), so refresh manually:
     add a `reload()` to `useWorktrees` (`worktrees.ts` — a bump counter in the
     effect's deps) and call it after success.
- Leave the ticket's **branch** alone — `git worktree remove` doesn't delete branches,
  and the archive already holds `diff.patch`. Branch cleanup is explicitly out of scope.

### B3. Verify & commit

- In a scratch workspace: activate a ticket, edit files in its worktree → badge shows
  the right count and updates within ~4s; dirty the repo root → badge on the main
  entry; clean → badges disappear.
- Create an orphan (e.g. `git worktree add` a dir named `t99` under `.iudex/worktrees/`,
  or archive a ticket and recreate its dir) → orphan badge + sentence; Remove works
  clean; dirty the orphan → confirm dialog wording shows the count, force path works;
  rail refreshes without an app restart.
- Commit: `feat(gui): worktree dirty badges + orphaned-worktree detection/removal`

---

## Part C — Auto-Retire: marked-for-death

Files: `gui/src-tauri/src/tmux.rs`, `gui/src-tauri/src/lib.rs`, `gui/src/lib/api.ts`,
`gui/src/types.ts`, `gui/src/lib/sessions.ts`, `gui/src/lib/automation.ts`,
`gui/src/views/Agents.tsx`, `gui/src/views/Settings.tsx`.

### C1. tmux plumbing (Rust)

- Two new tmux session user-options: `@iudex_retire_at` (kill deadline, **epoch
  milliseconds**, as a string — consistent with `@iudex_started`) and
  `@iudex_retire_pardon` (`1` = never auto-mark this session again).
- In `tmux.rs`: append `\t#{@iudex_retire_at}\t#{@iudex_retire_pardon}` to the
  `list-sessions -F` format string (survey: line 96), add matching fields to the
  `Session` struct (survey: lines 28–37) and `parse_line`, mirroring exactly how the
  existing optional fields (`role`, `started`) are represented and serialized —
  empty string ⇒ absent.
- Two new commands (both guard `name.starts_with("iudex-")` like `kill_session` does;
  register in `generate_handler!`, survey ~2255–2269):

  ```rust
  #[tauri::command]
  fn set_retire_at(name: String, epoch_ms: String) -> Result<(), String>
  // tmux set-option -t <name> @iudex_retire_at <epoch_ms>

  #[tauri::command]
  fn clear_retire(name: String, pardon: bool) -> Result<(), String>
  // tmux set-option -u -t <name> @iudex_retire_at
  // if pardon: tmux set-option -t <name> @iudex_retire_pardon 1
  ```

### C2. Grace-period setting

- Follow the `gui_kill_pool_on_exit` precedent in `lib.rs` (survey ~207–234;
  `yaml_scalar` / `yaml_upsert_scalar` on `~/.iudex/config.yml`): key
  `gui_retire_grace_minutes`, parsed as `u32`, **default 10** when absent/unparsable.
  Commands `get_retire_grace_minutes` / `set_retire_grace_minutes`, registered next to
  the existing gui getters/setters.
- `api.ts`: `getRetireGraceMinutes` / `setRetireGraceMinutes`.
- `Settings.tsx` → `BehaviorTab` (survey ~384–453, local-until-Save pattern): a number
  input (min 0, integer) labeled "Retire grace period (minutes)" with helper text
  "How long a superseded agent's session lingers before it is killed. 0 = immediately."

### C3. Session type + store

- `gui/src/types.ts` `Session` (survey ~176–184): add `retireAt?: string` and
  `retirePardon?: boolean` (match however the Rust side serializes; keep the mirror
  exact).
- `gui/src/lib/sessions.ts` `sessionsEqual` (survey ~68–85): **add both new fields to
  the comparison** — otherwise the store never notices a stamp and the UI won't update.

### C4. Engine logic (`gui/src/lib/automation.ts`)

- **Default ON:** `autoRetire` initial state `true` (survey: line 39), and the
  workspace-change reset block (survey ~89–106) resets it to `true` (the other engines
  keep resetting to `false`). It stays session-only and the Sidebar/Dashboard toggle
  rows are unchanged.
- **Do NOT add `autoRetire` to the condition arming the 5s `load(root)` interval**
  (survey ~421–426) — with a default-on engine that condition would silently make the
  app shell `iudex status --json` every 5s forever. Retire logic gets fresh `ws` from
  the doorbell and fresh `sessions` from the 2s sessions poll; that is sufficient.
- **Stamp instead of kill** — rework the superseded effect (survey ~399–416): for each
  superseded agent session (existing `AGENT_PHASE = { impl: "active", qa: "pending-qa",
  resolve: "pending-human-qa" }` filter — do not modify `AGENT_PHASE`, nor its
  read-only twins in `agents.ts`/`home.ts`) that has **no `retireAt`, no
  `retirePardon`, and is not in `retiredRef`**:
  - fetch grace = `await api.getRetireGraceMinutes()` (fetching at stamp time is fine);
  - if grace `=== 0`: `killSession(name)` directly (preserves old immediate behavior);
  - else `setRetireAt(name, String(Date.now() + grace * 60_000))`;
  - add the name to `retiredRef` (it now means "stamped or killed", keeping its
    dedupe role).
- **Sweep:** kill any session whose `retireAt` parses and is `<= Date.now()` — the
  stamp is the authority, regardless of role/phase. Two triggers: (a) the existing
  effect whenever sessions/ws change, and (b) **a dedicated ~30s `setInterval`, active
  while `autoRetire` is on** — required because a deadline expiring changes no polled
  data, so nothing else re-fires the effect. Guard repeat kills with a small
  `sweptRef: Set<string>`; swallow kill errors like the current code does. Marks live
  in tmux, so they survive GUI restarts and the sweep resumes naturally.
- **Toggle OFF:** in `toggleAutoRetire` (survey ~121–124), when turning off, first call
  `clearRetire(name, false)` for every session that has a `retireAt`, then clear
  `retiredRef`/`sweptRef` and set state. Disarm means nothing dies.

### C5. Agents view (`gui/src/views/Agents.tsx`)

- In the rail card's `cardBot` (survey ~203–208), when `retireAt` is set and in the
  future: render a countdown chip **"retiring in Nm"** (ceil to minutes; under one
  minute show `<1m`) and a small **Keep** button (`variant="quiet" size="sm"`) that
  calls `api.clearRetire(name, true)` — pardoned sessions are never auto-marked again
  and clear via the existing manual rail "Clear", as today. `stopPropagation` on the
  button so it doesn't select the card.
- Show the same chip + Keep in the `AgentDetail` header (near the existing "kill agent"
  button) for consistency.
- Countdown text refresh: a light local ticker (`useState(Date.now())` + 30s interval)
  active only while at least one session is retiring — the deadline itself is static in
  the poll snapshot.
- **Do not** add a new `AgentStatus` value — the chip is an independent element;
  `agentBucket`/`STATUS_LABEL`/`badges.ts` stay untouched.

### C6. Verify & commit

- Set grace to 1 minute in Settings (confirm it round-trips through
  `~/.iudex/config.yml`). Drive a ticket so its impl agent becomes superseded (agent
  runs `iudex finish`): chip appears within a poll cycle, session dies on schedule
  (even while its console is open — expected). **Keep** pardons: mark clears, chip
  disappears, session is never re-stamped, manual Clear still removes it.
- Toggle Auto-Retire OFF mid-countdown → mark cleared, nothing dies. Toggle back ON →
  re-stamped fresh.
- Restart the GUI mid-countdown → chip reappears (from tmux) and the kill still fires.
- Grace 0 → immediate kill (old behavior). Fresh app start shows Auto-Retire ON.
- Commit: `feat(gui): auto-retire marked-for-death — grace countdown, Keep pardon, default on`

---

## Execution order

Part A → Part C → Part B (each independently commitable; nothing in B/C depends on A).

## Out of scope (do not do)

- No branch deletion in Part B; no changes to `git`/`archive` Go packages.
- No refactor of the duplicated phase logic in `agents.ts`/`home.ts`.
- No new test frameworks; no README feature-marketing edits beyond removing `iudex spec`
  references.
