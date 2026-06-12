# Skill: improve-arch

**⚠ HUMAN-TRIGGERED ONLY. Agents must never invoke this skill autonomously.**

**Purpose:** Scan the codebase, surface architectural friction, and produce an HTML report of deepening opportunities — refactors that turn shallow modules into deep ones. Findings become inputs to `write-prd` and `create-tickets`, never direct code changes.

## How to use
Open a manual session and tell Claude:
"Use improve-arch on the codebase at project/worktrees/main"

## Glossary

Use these terms exactly. Consistent language is the point.

- **Module** — anything with an interface and an implementation (function, package, struct). _Avoid_: component, service, unit.
- **Interface** — everything a caller must know: type signature, invariants, error modes, ordering constraints. _Avoid_: API, signature (too narrow).
- **Depth** — leverage at the interface: how much behaviour a caller gets per unit of interface they learn. **Deep** = lots of behaviour behind a small interface. **Shallow** = interface nearly as complex as the implementation.
- **Seam** — a place where behaviour can be altered without editing that place; where a module's interface lives. _Avoid_: boundary.
- **Adapter** — a concrete thing satisfying an interface at a seam. Describes role, not substance.
- **Leverage** — what callers get from depth: more capability per unit of interface learned.
- **Locality** — what maintainers get from depth: change, bugs, and verification concentrate in one place.

Key principles:
- **Deletion test**: if deleting the module makes complexity vanish, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam.
- **One adapter = hypothetical seam. Two adapters = real seam.**

## Process

### 1. Explore

Read `docs/glossary.md` (if it exists) and any ADRs in `docs/adr/`. Then explore `project/worktrees/main` organically, noting friction:
- Where does understanding one concept require bouncing between many small modules?
- Where are modules shallow — interface nearly as complex as the implementation?
- Where do tightly-coupled modules leak across their seams?
- Which parts are untested or hard to test through their current interface?

Apply the deletion test to anything shallow.

### 2. HTML report

Write a self-contained HTML file to the OS temp directory: `$TMPDIR/architecture-review-<YYYY-MM-DD>.html`. Open it with `open <path>` on macOS. Tell the user the absolute path.

Use **Tailwind via CDN** for layout and **Mermaid via CDN** for diagrams.

For each candidate, render a card with:
- **Files** — which files/packages are involved
- **Problem** — one sentence; why the current architecture causes friction
- **Solution** — one sentence; what changes
- **Wins** — bullets using glossary terms (e.g. "locality: bugs concentrate in one module")
- **Before / After diagram** — side-by-side Mermaid or hand-built SVG
- **Recommendation strength** — `Strong` (emerald), `Worth exploring` (amber), `Speculative` (slate)

End with a **Top recommendation** section: which candidate to tackle first and why.

Do NOT propose interfaces yet. After writing the report, ask: "Which of these would you like to explore?"

Also save a text summary to `docs/design/arch-review-<YYYY-MM-DD>.md` so it persists in the repo if the human wants it.

### 3. Grilling loop

Once the user picks a candidate, drop into a grilling session (see `grill-me`). Walk the design tree one question at a time. Update `docs/glossary.md` inline as terms are resolved. Offer an ADR if the user rejects a candidate for a load-bearing reason worth preserving.

## Output
Claude writes a report — **not code changes**. The human decides which findings become tickets via `create-tickets`.
