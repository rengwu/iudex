# Button interaction states

Resolved design for the `Button` primitive's hover / active / focus states — the
fix for audit recommendation #1 (the primitive had **none** of these, because it
was built from an inline `style` object, where pseudo-classes can't be expressed).

Live mockup / source-of-record: [`designs/button-states.html`](./designs/button-states.html)
— the full variant × state matrix on both surfaces, the focus-ring option
comparison, and a live hover/press/Tab row.

## Resolved spec

| State | Rule | Why |
|-------|------|-----|
| **hover** | fill **+7% lightness**, uniform across all 7 variants; `quiet` gains a faint film + brighter border | matches the app's dominant neutral-surface convention (`$panel-light`/`$surface-c8` lighten on hover); absorbs Review's approve outlier, which today *darkens* |
| **active** | fill **−8% lightness**, flat — no inset shadow, no nudge | opposite direction from hover → rest → lift → press-in reads as a clear 3-step progression; flat stays true to the aesthetic |
| **focus** | `:focus-visible` only · **2px solid ring, 2px offset** · surface-contextual via `--btn-ring` · mouse `:focus` draws nothing | the a11y fix. Offset sits the ring *off* the button so it never fights the fill — that's how the amber `primary` still shows a ring. Amber-everywhere was rejected: amber fails WCAG focus contrast on light/gray surfaces |

> **Default = ink (`$text #2a2a2a`), not amber.** The mockup contrasted amber-on-dark vs
> ink-on-light, but the real app is *uniformly mid-gray* (`$canvas #929292` … `$panel-light
> #dadada`) — there is essentially no dark `#2a2a2a` chrome. Ink is ~4-5:1 on every panel;
> amber would be ~1.5:1 everywhere. So `--btn-ring` **defaults to ink**, and genuinely dark
> surfaces (the terminal) override with `--btn-ring: $amber`. The surface-contextual *rule*
> is unchanged; the default is just set to the tone the app actually is.
| **disabled** | opacity 0.4 (unchanged); no hover/active/focus | — |
| **motion** | ~90ms ease on background/border | — |

### Focus-ring alternatives considered
- **B — amber everywhere:** one token, but fails contrast on light panels. Rejected.
- **C — two-tone halo** (amber inner + near-black outer via `box-shadow`): bulletproof on any surface, but heavier/less flat, and `box-shadow` rings clip under `overflow:hidden`. Rejected in favor of A's offset ring.

## Implementation

`Button.tsx` moves from inline styles to a **CSS module** (`Button.module.scss`),
with `variant` and `size` as classes. This:

- makes the three states native CSS (`:hover` / `:active` / `:focus-visible`);
- keeps the JSX API (`variant` / `size` props) **identical** — no call-site changes;
- **decouples size from variant** — killing the old special-case where
  `quiet`/`danger`/`success`/`info` silently rendered smaller than
  `primary`/`secondary` at the same `size` (audit #7).

The surface-contextual focus ring uses a CSS custom property (`--btn-ring`,
default amber); light-surface containers set it to ink (`$text`).
