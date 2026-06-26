# iudex GUI — Design System

The implementation-true design reference for the iudex desktop GUI. It is **descriptive**
(what the current code does) and **prescriptive** (what new UI should follow). The code is
the living source — when this doc and the code disagree, the code wins and this doc is wrong.

> Supersedes the earlier `gui-design/` prototype (DESIGN.md + `.dc.html`), which was authored
> before the React build and has since diverged. Everything below is derived from
> `gui/src/` — the files that actually render the app.

---

## 1. The design language

**Ableton Live**: flat, square, dense, gray. A control surface, not a marketing page.

- **Flat & square** — no gradients, no rounded corners (the only radii are chips `2px`, the
  segmented pill `3px`, and status dots `50%`), shadows only on floating layers (modals).
- **Dense** — the app lives at **11–13px**; root is `12px`. Tight padding, thin dividers.
- **Hierarchy from weight + color, not size** — headings are `14px/600`, not large; emphasis
  comes from font-weight and the gray scale, not type ramps.
- **Gray canvas** — surfaces are a stack of grays (`#929292` → `#1d1d1d`); the only saturated
  color is signal.

### The load-bearing rule: **color is state, not decoration**

Saturated hue is reserved for meaning — a ticket's lifecycle state, an agent's status, merge
readiness, the active nav row. Nothing is colored "to look nice." Because color carries
meaning, every state→color mapping lives in **one** place (see §4); a call site never invents
a state color inline.

Fonts: **IBM Plex Sans** (UI) and **IBM Plex Mono** (code, IDs, badges, metadata), bundled
locally via `@fontsource` (imported in `src/main.tsx`) — no CDN, works offline under Tauri's
CSP. Exposed as `--font-ui` / `--font-mono` and the SCSS `t.$font-ui` / `t.$font-mono`.

---

## 2. Tokens

All tokens live in **`src/styles/tokens.scss`** — one source of truth, consumed as
`@use "../styles/tokens" as t;` then `t.$canvas`, `t.$amber`, etc.

### Surfaces — the gray DAW chrome (light → dark)

| Token | Value | Used for |
|-------|-------|----------|
| `$canvas` | `#929292` | main area / sidebar canvas background |
| `$chrome` | `#565656` | top bar |
| `$sidebar` | `#3f3f3f` | left nav rail |
| `$module` | `#1d1d1d` | terminal / diff background (near-black) |
| `$module-surface` / `$module-head` | `#2f333c` / `#20242e` | dark panel headers / diff hunk strip |
| `$panel-mid` | `#afafaf` | view headers, agent detail header |
| `$panel-light` | `#dadada` | active tab, light panel surface |
| `$panel-rail` | `#bdbdbd` | rail / panel / sub-header background |
| `$panel-detail` | `#828282` | detail-area background, scrollbar track |
| `$surface-c8` / `$field-read` / `$field-edit` | `#c8c8c8` / `#b8b8b8` / `#e8e8e8` | field fills / read-only / editable |

### Signal hues — state, never decoration

| Token | Value | Meaning |
|-------|-------|---------|
| `$amber` (`$amber-border`) | `#f4bc41` (`#c79320`) | active / on / primary |
| `$cyan` | `#5bc7d8` | editing / pending-qa |
| `$mint` | `#72f6aa` | level / progress / terminal accent |
| `$indigo` | `#1f2e90` | selected nav (default) |
| `$violet` (`$violet-border`) | `#836ddd` (`#5b46b0`) | review / pending-human-qa |
| `$danger` (`$danger-border`) | `#e0584c` (`#b03d33`) | error / failed / record |
| `$success` / `$success-fill` | `#5ccf5c` / `#3b853d` | running / merged / done (accent / readable fill) |
| `$info-fill` | `#3a6ea5` | blue button fill (white text) |
| `$periwinkle` | `#9ea0e0` | worktrees |

### Dividers, diff tints, text, selection

- **Dividers:** `$divider-dark #14171d` (dark panels), `$divider-mid #6f6f6f` (gray panels),
  `$divider-chrome #2a2a2a`, `$field-border #9a9a9a`.
- **Diff:** within the dark module — `$diff-add-bg/fg`, `$diff-del-bg/fg`; in gray panels the
  `+N`/`−N` stats use `$add-fg #15692f` / `$del-fg #a82d22`.
- **Text scale (weight+color hierarchy):** `$text #2a2a2a` (primary) · `$text-muted #565656`
  (secondary) · `$text-meta #8a8f99` (dim/overlines/sidebar meta) · `$text-light #cfcfcf` (on
  dark) · `$text-bright #e8e9eb` (active nav / headings on dark).
- **Selection (active nav row):** `$sel-bg #1f2e90` / `$sel-border #14206b` / `$sel-text #fff`
  / `$sel-text-dim rgba(255,255,255,.74)`.

> **Back-compat aliases** at the bottom of `tokens.scss` (`$bg`, `$accent`, `$green`, …) map
> the pre-reskin dark-theme names onto the new palette so older modules keep compiling. They
> are a migration crutch — don't reach for them in new code; use the named tokens above.

### 2.1 Visual rules

- **Square by default.** Radius is allowed only for: chips `2px`, the segmented pill `3px`,
  status dots `50%`. Everything else has `border-radius: 0`.
- **No gradients.**
- **Shadows only on floating layers** — modals/overlays (e.g. `Modal`'s
  `box-shadow: 0 8px 28px rgba(0,0,0,.4)`). Inline chrome is flat.
- **Scrollbars:** `10px`, thumb `$divider-mid #6f6f6f` on track `$panel-detail #828282`
  (`base.scss`).

---

## 3. Conventions

### Styling: co-located CSS Modules

- Each component/view has a co-located **`X.module.scss`** next to `X.tsx`, imported as
  `import s from "./X.module.scss"` and used as `className={s.card}`.
- **camelCase** class names (scoping makes the old `ag-`/`rv-` prefixes unnecessary).
- Dynamic classes via template strings: `` `${s.card} ${active ? s.active : ""}` ``; mix scoped
  + global freely: `` `${s.empty} muted` ``; target a global class inside a scoped rule with
  `:global(.ghost)`; index dynamic variants with `` s[`st${status}`] ``.
- **Globals live only in `src/styles/base.scss`** — the resets plus a few intentionally
  unscoped utilities: `.mono`, `.muted`, `.error`, `.field` (label-over-control form field),
  `.stub` / `.stub-tag` (empty/unavailable panels), and the interim flat buttons
  `.ghost` / `.esc` / `.go` (being migrated to the shared `<Button>`).

### Clickable ⇒ not text-selectable

Anything the user clicks — `<button>`, and the `<div>`/`<span>` "controls" (tabs, ticket
cards, table rows, the board clips, segmented switchers) — must not be text-selectable, so a
click or drag never highlights its label. The rule is mechanical: **`cursor: pointer` always
travels with `user-select: none`**, declared in the same block (or the same inline `style`).
When you add a clickable surface, add both together. Plain content regions (briefs, logs,
diffs) stay selectable — only pointer-cursored controls opt out.

**Always write the `-webkit-` prefix explicitly** (`-webkit-user-select: none;` alongside
`user-select: none;`, or `WebkitUserSelect` next to `userSelect` inline). The app runs in
Tauri's **WKWebView**, which ignores the unprefixed property; esbuild only adds the prefix in
`vite build`, so without it text stays selectable in `tauri dev`.

### Layout: sticky chrome, one scroll region

`App.module.scss` `.app` is `height: 100vh; display: flex; flex-direction: column;
overflow: hidden`. The top bar and nav rail are pinned (`flex: none`); only the active view
scrolls. Viewport-sized views (terminal/worktrees/review) fill height rather than growing the
page. The top bar uses `$chrome`, the left nav rail `$sidebar`, and every view opens with a
30px `ViewHeader` on `$panel-mid`.

### Adding UI (the rule of thumb)

> New view → new `X.module.scss`. Cross-cutting primitive → add it to `base.scss`. Reused UI →
> extract a shared component in `components/`. Never hardcode a **state** color at a call
> site — register it in the appropriate source (§4).

---

## 4. Color is state — the single sources

State→color is centralized so meaning can't drift. Four registries, by domain:

- **`src/styles/tokens.scss`** — the signal hues (§2) for SCSS modules.
- **`src/lib/badges.ts`** — every badge/chip/dot **color + label**, the canonical state map:
  - `TICKET_STATE` — `queued` (gray/periwinkle dot) · `active` (amber) · `pending-qa` (cyan) ·
    `pending-human-qa` (violet) · `done` (green) · `failed` (red) · `removed` (gray). Each is a
    `StateStyle { bg, fg, dot, label, short, dark? }` (the `dark` fill is for the graph's dark
    surface).
  - `MERGE` — `clean` / `conflicts` / `resolving` (Review merge-readiness; labels are dynamic,
    so only color lives here).
  - `ROLE_STYLE` — agent roles are **monochrome** (the label conveys the role, not color).
  - `AGENT_STATUS` — synthesized status → dot color (`working`/`done`/`resolved` green,
    `idle`/`awaiting-finish` amber, `review-ready` violet, `flagged` amber-warn, `crashed` red,
    `gone` gray).
  - Helpers: `ticketState(s)`, `stateDot(s)`, `agentStatusColor(s)`.
- **`src/types.ts` `VIEWS`** — `Record<View, ViewConfig>` keying each view's nav **dot color**
  (e.g. `VIEWS.agents.dot`). Single source for per-view dots; `ViewHeader`s read from it.
- **`src/lib/monacoSetup.ts`** — the `iudex-light` Monaco theme: a light editor on the gray
  `#dadada` surface with soft diff tints, so the read-only diff viewer matches the palette.

The shared `<Badge>` resolves its colors **only** from `badges.ts` (by `kind`+`value`); bare
status dots read `stateDot` / `agentStatusColor` / `VIEWS[id].dot`. Add a new state once, here.

---

## 5. Component vocabulary

Shared building blocks in `src/components/` (and the shared diff surfaces). Prefer these over
bespoke markup.

| Component | Purpose | Key API |
|-----------|---------|---------|
| **`Button`** | Flat square action button; color = state | `variant` `primary`(amber) · `secondary`(gray) · `review`(violet) · `danger`(red) · `quiet`(transparent); `size` `sm`(20px) / `md`(22px) |
| **`Badge`** | The one filled chip across the app | `kind` `state`/`merge`/`role` + `value`; `tone` `light`/`dark`; `bg`/`fg` escape hatch; `children` overrides label. Mono 10px, radius 2px |
| **`ViewHeader`** | 30px header strip atop every view | `dot` (from `VIEWS`), `title` (14/600), `subtitle?`, `children` = right-aligned action slot; bg `$panel-mid` |
| **`TabSwitcher`** | Segmented pill for 2–4 tabs | `tabs`, `value`, `onChange`; active fill `$panel-light`, pill radius 3px |
| **`Overline`** | Small uppercase section label | 10px, letter-spaced; `tone` `light`/`dark` |
| **`SectionHeader`** | Sidebar column label strip | `tone`, `pad`, `noBorder`, `borderTop` |
| **`Modal`** | Floating dialog shell | `.backdrop` + `.box` (560px, the sanctioned shadow) + `actions` slot |
| **Diff surfaces** | `DiffViewer` (shared read-only Monaco, inline/split, `iudex-light`), `MergeEditor` (the one editable Monaco surface, for conflict resolution), `ChangedFilesDiff` (file list + diff), `DiffPatch` (unified-patch render) | Monaco is bundled locally and lazy-loaded (`lib/monacoSetup.ts`); read-only everywhere except `MergeEditor` |

> **Read-only Monaco everywhere** is an invariant — the editor is for *viewing* diffs. The one
> bounded exception is `MergeEditor` (resolving a flagged conflict), and its result still
> passes the human-QA gate.

---

## 6. Known characteristic: the token ↔ inline-style duality

There are currently **two** color mechanisms, and a faithful reading should know both:

1. **SCSS tokens** (`tokens.scss`) — consumed by every `.module.scss`.
2. **Inline-styled literals** — the React component ports (`Button`, `Badge`, `ViewHeader`,
   `TabSwitcher`, `Overline`, `SectionHeader`) and `lib/badges.ts` / `types.ts VIEWS` carry
   **hardcoded hex** inline, mirroring the token values rather than importing them.

The two are kept in agreement by hand (the hex values equal the tokens). This is a deliberate
artifact of porting the `.dc.html` components to inline-styled React, not an accident — but it
**is** a duplication: a palette change must touch both `tokens.scss` and the inline ports.

**Future-consolidation candidate:** thread the tokens into the component ports (e.g. via CSS
custom properties already exposed on `:root`, or by importing the token values) so there's a
single palette source. Until then: when you change a color, change it in **both** places, and
keep new **state** colors in the §4 registries regardless of which mechanism the component uses.

---

*Living sources:* `src/styles/{tokens,base}.scss` · `src/components/*` ·
`src/lib/{badges,monacoSetup}.ts` · `src/types.ts` (`VIEWS`) · `src/App.module.scss`.
