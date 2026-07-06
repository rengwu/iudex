# Dashboard Free-Arrangement Canvas — Execution PRD

> **Status:** approved for implementation, 2026-07-04.
> **Audience:** the implementing agent. This document is self-contained — every
> rule, algorithm, schema, and default value you need is embedded here; you never
> need my session context.
> **Base:** branch `feat/gui-packaging`. All references to code are by
> **symbol/grep, never by line number** — locate them yourself.
> **Ground rules:** do not touch anything outside the changes specified here.
> Match the surrounding code's style, naming, and comment density (see any
> existing view + its `.module.scss`). Run a part's verification before committing
> it. One commit per part (messages given). Do **not** add any Co-Authored-By or
> AI attribution to commits.
> **Scope guard:** this is a **pure `gui/` front-end change**. No CLI, no Rust
> (`src-tauri`), no Go, no backend command changes. It touches only the Dashboard
> view, one new layout-store module, and one new canvas component.

## Background

iudex's Tauri GUI (`gui/`) has a **Dashboard** view (`gui/src/views/Dashboard.tsx`
+ `Dashboard.module.scss`) that is the home screen. Today it is **one aligned CSS
grid** of six read-derived modules on a gray canvas:

```
grid-template-areas:
  "now  now      now"        // NOW      — priority action chips (full width)
  "pipe pipe     pipe"       // PIPELINE — the state-machine columns (full width)
  "start auto    activity"   // START(col1 top) · AUTOMATION(col2) · ACTIVITY(col3)
  "shells auto   activity";  // SHELLS(col1 bottom) · (auto & activity span 2 rows)
```

The six module components live in `Dashboard.tsx`: `NowStrip` (title `NOW`),
`Pipeline` (`PIPELINE`), `StartPanel` (`START`), `ShellsPanel` (`SHELLS`),
`AutomationPanel` (`AUTOMATION`), `Activity` (`ACTIVITY`). Each renders a
`<section className={s.zone ...}>` whose first child is a
`<div className={s.zoneTitle}>TITLE</div>`, followed by its body. The grid itself
is the `<div className={s.grid}>` inside `<div className={s.dash}>`; `.grid` is
`display:grid` today and reflows with the viewport.

**The change:** replace that grid with a **free-arrangement canvas**. Each module
becomes an absolutely-positioned, draggable, resizable panel. The core invariant
is unchanged — every module stays read-derived and navigational; we are only
changing *how the modules are laid out*, not what they show or do.

---

## Settled decisions (the grilled spec — do not re-litigate)

1. **Freeform absolute canvas replaces the grid.** Each panel has a top-left
   anchor `{x, y}` and a size `{w, h}`, positioned like an absolute `div`.
2. **Overlap is allowed.** Panels may sit on top of each other; **click-to-front**
   raises the clicked panel's z-order.
3. **Drag** is initiated only from a panel's **header/title strip** (a dedicated
   grab handle). The panel **body stays fully interactive** (its buttons, inputs,
   lists work normally).
4. **Resize** from **all 8 handles** (4 corners + 4 edges), clamped to a
   **per-module minimum** size (Part C).
5. **Snap** on **both move and resize**, to **other panels' edges and the
   viewport edges**, leaving a **slight gap**. Snapping is **silent** (no guide
   line). Snapping is a **drop-time assist**, not a live binding — a later
   viewport resize never re-aligns anything.
6. **Overflow:** panels dragged/resized past the **bottom/right** grow the canvas
   and produce scrollbars. A panel dragged past the **top/left** is **clamped
   back** into the safe zone (`x >= 0`, `y >= 0`) on pointer-release.
7. **Viewport resize never** reflows, repositions, or resizes any panel.
8. **Persistence:** the layout (`{x, y, w, h, z}` per panel) is saved to
   **`localStorage`, keyed by workspace root**. It is a pure UI preference — no
   config, no CLI, no `.iudex/` files.
9. **Reset:** a **"Reset layout" button** in the Dashboard header restores the
   default arrangement (clears the saved blob).
10. **All six modules are always visible.** No close / hide / add UI, so there is
    no per-panel visibility state to persist — only geometry.
11. **Initial arrangement** transcribes today's grid (defaults table below).
    Exact default sizes are not sacred — they can be tuned later.

---

## Design detail

### Coordinate system & the canvas element

- The Dashboard becomes: a **scroll container** (`overflow: auto`, fills the view
  below the header) wrapping a **positioned canvas** (`position: relative`).
- Each panel is `position: absolute; left: x; top: y; width: w; height: h;
  z-index: z`.
- The canvas's own size is **derived from the panels**, so it grows to contain the
  furthest one and the scroll container shows scrollbars automatically:
  `canvasW = CANVAS_PAD + max over panels of (x + w)`,
  `canvasH = CANVAS_PAD + max over panels of (y + h)` (use `CANVAS_PAD = 8`).
  Set these as the canvas element's `min-width` / `min-height` (inline style),
  recomputed from the layout on every render. Panels **never** read the viewport
  size — this is what makes rule 7 hold by construction.
- All coordinates are **canvas coordinates** (not viewport/client coordinates).
  Convert pointer client coords to canvas coords once at drag start by capturing
  the canvas element's `getBoundingClientRect()` and its scroll offsets, or
  (simpler and sufficient) work purely in **deltas**: on pointer-move, apply
  `clientX - startClientX` to the panel's `startX`. Deltas need no coordinate
  conversion and are immune to scroll — prefer this.

### The layout store — `gui/src/lib/dashboardLayout.ts` (new)

Types and hook (mirror the project's existing hook idioms, e.g.
`gui/src/lib/worktrees.ts`):

```ts
export type PanelBox = { x: number; y: number; w: number; h: number; z: number };
export type Layout = Record<string, PanelBox>; // keyed by panel id

export const PANEL_IDS = ["now", "pipe", "start", "shells", "auto", "activity"] as const;
export type PanelId = (typeof PANEL_IDS)[number];
```

- **Version + key:** `const LAYOUT_VERSION = 1;` and
  `const keyFor = (root: string) => \`iudex.dashboard.layout:\${root}\`;`.
- **Stored shape:** `{ v: number; panels: Layout }`.
- **Load (on mount / when `root` changes):** read `localStorage[keyFor(root)]`;
  `JSON.parse` in a try/catch. If missing, unparseable, or `v !== LAYOUT_VERSION`,
  use `DEFAULT_LAYOUT` wholesale. Then **merge**: for every id in `PANEL_IDS`, use
  the stored box if present, else the default box (so a newly added panel gets a
  sane default without discarding the user's other positions). Ignore any stored
  id not in `PANEL_IDS`.
- **Persist:** on any geometry change, write `{ v: LAYOUT_VERSION, panels }` back.
  **Debounce to the end of an interaction** — do not write on every pointer-move.
  Simplest correct approach: keep the live layout in React state (updated on
  pointer-move for smooth rendering) and call a `persist()` on **pointer-up**
  only. (A short `setTimeout` debounce is also fine.) Swallow `localStorage`
  errors (private-mode quotas etc.) — a failed write must never break the view.
- **Hook API:**
  ```ts
  useDashboardLayout(root: string): {
    layout: Layout;
    setBox(id: PanelId, box: PanelBox): void;   // live update (no persist)
    commit(): void;                              // persist current layout
    bringToFront(id: PanelId): void;             // z = max(z)+1, then commit
    reset(): void;                               // layout = DEFAULT_LAYOUT, clear storage
  }
  ```
  `bringToFront` sets the panel's `z` to `1 + max(all z)` (leave others as-is) and
  commits. `reset` restores `DEFAULT_LAYOUT` (deep-cloned) and removes the
  `localStorage` key.

### Default layout (`DEFAULT_LAYOUT`) — transcribes today's grid

Reference canvas ~1200 wide, `gap 8`, `pad 8`; three lower columns of 388 px.
These are the initial `{x, y, w, h, z}` (z ascending in render order):

| id       | x   | y   | w    | h   | z |
| -------- | --- | --- | ---- | --- | - |
| now      | 8   | 8   | 1184 | 88  | 1 |
| pipe     | 8   | 104 | 1184 | 280 | 2 |
| start    | 8   | 392 | 388  | 150 | 3 |
| shells   | 8   | 550 | 388  | 150 | 4 |
| auto     | 404 | 392 | 388  | 308 | 5 |
| activity | 800 | 392 | 388  | 308 | 6 |

(This reproduces "NOW and PIPELINE full-width bands; then START-over-SHELLS in
column 1, AUTOMATION in column 2, ACTIVITY in column 3.")

### The canvas panel — `gui/src/components/CanvasPanel.tsx` (new)

A reusable wrapper that provides the chrome (header handle + 8 resize handles +
absolute positioning) and reports geometry changes. Signature:

```ts
export default function CanvasPanel({
  id, title, box, minW, minH, children,
  onChange,        // (box: PanelBox) => void  — live, during drag/resize
  onCommit,        // () => void               — on pointer-up
  onFocus,         // () => void               — bring-to-front (pointer-down anywhere)
}: {
  id: PanelId; title: string; box: PanelBox; minW: number; minH: number;
  children: React.ReactNode;
  onChange: (b: PanelBox) => void; onCommit: () => void; onFocus: () => void;
}): JSX.Element;
```

Structure:
- Root `<section>` styled `position:absolute` from `box` (+ `zIndex: box.z`), reusing
  the existing `.zone` look (background `t.$panel-rail`, `1px solid #7f7f7f`).
- A **header** `<div>` (the old `.zoneTitle` role, now a grab handle): shows
  `title`, `cursor: move`, `touch-action: none`. Pointer-down here (primary
  button) starts a **move**.
- The **body** wraps `children` with `overflow: auto` and its own min-height 0, so
  content scrolls internally when the panel is smaller than its content.
- **Eight resize handles**: thin absolutely-positioned zones on the 4 edges and 4
  corners (e.g. 6 px wide strips; corners 10×10). Each carries a direction
  (`n/s/e/w/ne/nw/se/sw`) and `cursor` (`ns-resize` etc.). Pointer-down starts a
  **resize** in that direction.
- **Bring-to-front:** a pointer-down anywhere on the section (capture phase, before
  it reaches buttons) calls `onFocus()`. Do **not** `preventDefault` on the body —
  the body's buttons/inputs must keep working.

**Pointer mechanics (both move and resize):**
- On handle/header pointer-down: record `startClientX/Y` and a copy of the current
  `box`; call `el.setPointerCapture(e.pointerId)`; set a local `dragging` state.
  Attach `pointermove`/`pointerup` (on the captured element or `window`).
- On pointer-move: compute `dx = e.clientX - startClientX`, `dy = e.clientY - startClientY`.
  - **Move:** `next = { ...start, x: start.x + dx, y: start.y + dy }`.
  - **Resize:** apply `dx/dy` only to the edges implied by the direction:
    - `e`/`w` change width (and `w` also shifts `x`); `s`/`n` change height (and
      `n` also shifts `y`); corners do both.
    - Example `nw`: `x = start.x + dx; y = start.y + dy; w = start.w - dx; h = start.h - dy`.
    - Example `se`: `w = start.w + dx; h = start.h + dy` (x/y unchanged).
  - **Clamp to min size** (Part C provides real mins; use a uniform floor until
    then): never let `w < minW` or `h < minH`. For edges that move the origin
    (`n`,`w`, and their corners), when clamping the size also stop moving the
    origin so the opposite edge stays put.
  - Run the **snap** pass (Part B) on `next` (no-op in Part A).
  - Call `onChange(next)` — the store updates React state and the panel
    re-renders at the new geometry.
- On pointer-up: **clamp top/left overflow** — `x = max(x, 0)`, `y = max(y, 0)`
  (rule 6; use `0`, the safe-zone origin). Call `onChange` once more with the
  clamped box, then `onCommit()` to persist. Release pointer capture, clear
  `dragging`.

> Bottom/right overflow is intentionally **not** clamped — it grows the canvas and
> shows scrollbars.

### Snapping algorithm (Part B)

Constants: `const SNAP_GAP = 8;` (the "slight gap"), `const SNAP_THRESHOLD = 8;`
(max px distance at which a snap engages).

The snap operates on **1-D independently** for the x-axis and the y-axis. Define a
helper that, given the set of **moving edges** and their candidate **target
lines**, returns the single best delta to apply (or 0):

```
snap1D(movingEdges: {pos:number}[], targets:number[], threshold):
  best = { delta: 0, dist: threshold + 1 }
  for each edge in movingEdges:
    for each t in targets:
      d = t - edge.pos
      if abs(d) <= threshold and abs(d) < best.dist:
        best = { delta: d, dist: abs(d) }
  return best.delta
```

**Building the target lines**, given the other five panels' current boxes and the
visible viewport edges (in canvas coords: `vpLeft = scrollLeft`,
`vpRight = scrollLeft + clientWidth`, likewise top/bottom):

- **Vertical (x) targets** — for each other panel `m` add:
  `m.x` (align-left), `m.x + m.w` (align-right),
  `m.x - SNAP_GAP` (sit to its left with a gap: target for *my right edge*),
  `m.x + m.w + SNAP_GAP` (sit to its right with a gap: target for *my left edge*).
  Plus viewport: `vpLeft`, `vpRight`.
- **Horizontal (y) targets** — symmetric with `m.y`, `m.y + m.h`,
  `m.y - SNAP_GAP`, `m.y + m.h + SNAP_GAP`, `vpTop`, `vpBottom`.

**Applying it:**
- **Move:** moving x-edges are `{left: x, right: x+w}`; compute
  `dx = snap1D(those, xTargets, T)` and shift **both** by `dx` (i.e. `x += dx`).
  Same for y with `{top: y, bottom: y+h}` → `y += dy`. (Edge-align and
  gap-align both fall out of the shared target set; nearest wins.)
- **Resize:** only the **dragged** edges are "moving". If dragging the east edge,
  the moving x-edge is `{right: x+w}` → snapping adjusts `w` (`w += dx`). West
  edge → moving `{left: x}` → adjust `x` and `w` (`x += dx; w -= dx`). North/south
  → height similarly. Corners snap on both axes. **Re-apply the min-size clamp
  after snapping** so a snap can't shrink a panel below its minimum.

Snapping is silent — no guide element. Do not add one.

### Reset button

Add a **"Reset layout"** control to the Dashboard header. `ViewHeader` already
renders `children` on the right (see `Specifications.tsx`, which passes a
`<Button>` child). Pass a `<Button variant="quiet" size="sm" onClick={reset}>Reset
layout</Button>` to the existing `<ViewHeader … title="Dashboard">`.

---

## Execution order & parts

**Part A → Part B → Part C.** Each is independently committable and testable.

### Part A — Canvas scaffolding, layout store, drag/resize/overflow/z-order

1. Add `gui/src/lib/dashboardLayout.ts` (types, `PANEL_IDS`, `DEFAULT_LAYOUT`,
   `LAYOUT_VERSION`, `useDashboardLayout`). Persist to `localStorage` (debounced to
   commit), version-gated load, merge with defaults.
2. Add `gui/src/components/CanvasPanel.tsx` (header grab handle, 8 resize handles,
   absolute positioning, pointer mechanics for move + resize, min-size clamp with a
   **uniform temporary floor** `minW=200, minH=100`, top/left clamp on pointer-up,
   bring-to-front on pointer-down). **No snapping yet** (the snap call is a no-op /
   absent in Part A).
3. Rework `Dashboard.tsx`:
   - Replace the `.grid` container with the **scroll container + positioned
     canvas** (canvas `min-width/height` derived from the layout as specified).
   - Wrap each of the six modules in a `<CanvasPanel id title box … >`. Refactor
     each module component so it **no longer renders its own
     `<section className={s.zone}>` + `<div className={s.zoneTitle}>`** — instead it
     returns just its **body** content, and the title moves to the `CanvasPanel`
     `title` prop. (Keep all module logic/props identical; only the outer
     `section`/title wrapper moves out.)
   - Add the **Reset layout** button to `ViewHeader`.
4. Update `Dashboard.module.scss`: replace `.grid` (and the `grid-area` rules on
   `.now/.pipe/.start/.shells/.auto/.activity`) with the canvas/scroll-container
   styles and the `CanvasPanel` chrome (or move panel chrome into a new
   `CanvasPanel.module.scss` — your call; keep the existing `.zone`/`.zoneTitle`
   look). Delete now-dead grid rules. Keep every inner module style
   (`.nowGrid`, `.cols`, `.latchGrid`, `.evtList`, etc.) untouched.
5. Update the file-top comment in `Dashboard.tsx`/`.scss` that describes "one
   aligned CSS-grid of modules" to describe the free canvas.

**Verify A:** `cd gui && npx tsc --noEmit` clean and `npx vite build` succeeds. In
`pnpm tauri dev`: all six modules render at their default positions matching
today's arrangement; dragging a header moves a panel; the 8 handles resize it;
panel bodies stay interactive (idea launcher input types, chips navigate); dragging
a panel far right/down produces scrollbars; dragging it off the top/left snaps it
back to `>=0,>=0` on release; clicking a covered panel raises it; **reloading the
app restores the arrangement** (localStorage); Reset layout returns to defaults;
resizing the OS window never moves/resizes any panel.

**Commit A:** `feat(gui): Dashboard free-arrangement canvas — drag/resize/persist`

### Part B — Snapping (move + resize, module + viewport edges, silent)

1. Add the snap constants + `snap1D` helper + target-line construction (per the
   algorithm above), in `CanvasPanel.tsx` or a small `gui/src/lib/snap.ts`.
2. `CanvasPanel` needs the **other panels' boxes** and the **viewport edges** to
   build targets — pass the sibling boxes down from `Dashboard` (e.g. an
   `others: PanelBox[]` prop, or the whole `layout` minus this id) and read the
   scroll container's `scrollLeft/Top` + `clientWidth/Height` at drag start.
3. Apply snapping inside the pointer-move computation for both move and resize,
   re-clamping to min size afterward.

**Verify B:** dragging a panel so an edge nears another panel's edge snaps it to a
small consistent gap; aligning two edges makes them land flush; edges snap to the
visible viewport edges; snapping is silent; resizing an edge toward a neighbor
snaps the resized edge and never shrinks below the min. `tsc`/`vite build` clean.

**Commit B:** `feat(gui): canvas edge-snapping on move and resize`

### Part C — Per-module minimum sizes + graceful-at-min bodies

1. Add a **per-panel min-size registry** (in `dashboardLayout.ts`), e.g.
   `MIN_SIZE: Record<PanelId,{minW:number;minH:number}>`, and pass each panel its
   `minW/minH` (replacing the uniform Part-A floor). Suggested starting values
   (tune while testing): `now 320×72`, `pipe 480×160`, `start 260×150`,
   `shells 220×110`, `auto 260×230`, `activity 260×150`.
2. For each of the six module **bodies**, confirm it looks acceptable across the
   range from its min size up: the body already scrolls (Part A wraps it in an
   `overflow:auto` container), but check for horizontal blowouts — e.g. `Pipeline`'s
   five columns need horizontal scroll (not squashed) when narrow; `NowStrip`'s
   `auto-fill` chip grid should collapse to one column cleanly; `Activity`/`ShellsPanel`
   lists should scroll vertically. Add per-module CSS only where a body breaks
   (min-content widths, `overflow-x:auto` on a columns row, etc.). Do not redesign
   any module — only make it survive small sizes.

**Verify C:** shrink every panel to its minimum — none clips its title/controls
unusably; lists and columns scroll rather than overflow the panel; no panel can be
resized below its registered min. `tsc`/`vite build` clean.

**Commit C:** `feat(gui): per-module min sizes + graceful small-canvas panels`

---

## Out of scope (do not do)

- No close/hide/add-module UI; all six are always present.
- No snap **guide lines** or overlap **prevention** (overlap is allowed).
- No CLI/Rust/Go/backend changes; no new Tauri commands; no `.iudex/` writes.
- No change to what any module *shows* or *navigates to* — only its layout chrome.
- No new drag/resize dependency unless you find hand-rolling infeasible; prefer
  hand-rolled pointer events to fit the existing design system. If you do reach for
  a library, note why in the commit body.
- No redesign of module internals beyond making them survive their minimum size.
```
