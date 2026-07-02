# iudex — open-source launch plan

> Strategy session 2026-07-03. Product study, competitive analysis, monetization
> decision, and the phased release plan. This is the working document for taking
> iudex public.

## Positioning

**The moat is the full pipeline, not the worktrees.** The market split into two
categories, and iudex is the only tool that owns both ends:

- **Category A — worktree orchestrators** (Conductor, Claude Squad, Nimbalyst,
  the late Vibe Kanban): run N agents in parallel, review diffs, merge. Crowded,
  commoditizing — by Q1 2026 every major AI coding tool shipped native worktree
  support. Constant absorption risk from Claude Code / Cursor / Codex.
- **Category B — spec-driven development** (GitHub Spec Kit ~93k stars, AWS
  Kiro, BMAD-METHOD, OpenSpec ~52k stars): shape work into specs/tasks, then
  stop. None orchestrate parallel implementation; none have a QA rejection
  ladder; none gate the merge.

iudex = **idea → PRD → tickets → parallel execution → QA gate → human gate →
merge**, end to end. Market that assembly line.

Secondary distinctive angles:

- **The economic pitch:** shape and judge with a strong model, execute with
  weak/cheap models in parallel. Nobody markets this arbitrage clearly.
- **The trust pitch:** verification is the community's acknowledged bottleneck;
  iudex's QA gate + reject counter + preflighted merge is the direct answer.
  "Nothing reaches main without passing the gate."
- **The architecture pitch (HN catnip):** append-only `events.jsonl` as sole
  source of truth, state as pure replay, GUI holds zero authoritative state, no
  daemon, no dependency beyond git. Worth its own blog post.

Positioning line candidates:

- "Vibe coding with a paper trail."
- "An assembly line for AI coding agents: brainstorm with a strong model,
  execute with cheap ones, and nothing merges without passing the gate."
- "Spec-driven development that doesn't stop at the spec."

Vocabulary: use **"vibe coding"** in headlines (the audience's word) and
**"spec-driven development"** in body copy (the market's word, for search and
category comparisons). Naming the *method* (the funnel) is more shareable than
naming the tool.

## Monetization decision: NOT at launch

Case study: **Vibe Kanban shut down April 2026 at ~30,000 MAU** — "the vast
majority are free users and we couldn't find a business model." Founder's exit
line: "Everyone who is making money is doing 2 things: selling to enterprise,
and reselling tokens. We were doing neither." An orchestrator is middleware; the
value is captured by the token/model layer. The originally considered model
(free CLI + DRM'd paid GUI) is almost exactly what failed.

Decisions:

- **No DRM, no payment processing, no license servers.** Months of work that
  make the launch worse; HN punishes "open CLI, crippled GUI" launches.
- **Everything free and open** — MIT or Apache-2.0, CLI and GUI both.
- GitHub Sponsors from day one (costs nothing, signals seriousness).
- Keep the future paid layer **additive, not subtractive**: team features,
  cloud sync of the event log, hosted review dashboard, support contracts —
  things companies need and individuals don't. Revisit only on real pull
  (unsolicited "can my team use this / support contract?" emails — that's the
  signal, not download counts).
- Only individual-payer model worth considering post-traction: paid
  signed/notarized/auto-updating convenience binary, free to build from source
  (Aseprite model).
- Realistic prize for a solo dev: reputation, audience, optionality. Treat
  revenue as a possible later bonus, not the goal.

## Usability verdict (honest)

Keep: every *decision* gate (QA verdict, human approve, reject-with-reason).
Kill: every mechanical step between gates. **The gates are the value; the
typing is the tax.**

- Ceremony per ticket is ~7 human steps vs Conductor's "type prompt → merge".
  Sequential mode + auto-advance of plumbing steps fixes the first-run
  experience without weakening the gates.
- Concept surface is big (7 states, skills, .context/, roles, two config
  scopes). Dashboard-as-home with a "next action" affordance means users never
  need to know the state machine to know what to click.
- Ticket authoring via `vim .iudex/queue/t$(...)` is meme-ably clunky — keep it
  off the README's first screen; lead with GUI compose / to-issues.
- tmux dependency ⇒ macOS/Linux only. Acceptable at launch (Conductor is
  macOS-only) but say it loudly or it becomes GitHub issue #1.
- Chat-like idea view matters more than it seems: ideation is the front door of
  the "structured vibe coding" pitch and a terminal is a hostile front door.
  Deferred to v1.1 → it becomes the second launch headline.

## Phase 1 — pre-launch (~4–6 weeks), priority order

1. **Packaging** ⟵ IN PROGRESS: GUI bundle with the iudex binary embedded
   (Tauri sidecar), signed + notarized macOS build, Linux build. One download,
   zero setup.
2. **Sequential-mode toggle** + minimal auto-advance (auto-activate next ready
   ticket when a slot frees).
3. **Dashboard as home** with next-action affordances (backlog #4 first, as
   already decided in `.context/prd/gui-ux-fixes.md`).
4. **README rewrite + 2-min demo video + landing page.** Record iudex building
   a feature of iudex — the dogfooding story is the best launch content.
   README: GIF above the fold → the "why" in 3 sentences → funnel diagram →
   60-second quickstart (no vim incantation) → honest comparison table
   (vs Conductor / Spec Kit) → screenshots of all seven views.
5. Licenses, CONTRIBUTING.md, issue templates, a few good-first-issues.
6. **Deferred:** chat-like idea view (v1.1 headline), Windows support, all
   DRM/payments.

Website: one static landing page (GitHub Pages/Astro, existing design-system
aesthetic) with video + diagram + download button. The README is the real front
door; don't over-invest.

## Phase 2 — launch week

- **Show HN** first, weekday morning US time. Title shape: "Show HN: Iudex –
  state-machine assembly line for AI coding agents (idea → PRD → tickets →
  QA-gated merge)". Be present in comments all day; lead with architecture and
  honesty about limitations.
- Same week, staggered: r/ClaudeAI, r/ChatGPTCoding, r/ExperiencedDevs (angle:
  "how I stopped reviewing slop"), lobste.rs, X thread with the demo video.
- Companion blog post that is a **story, not a pitch**: "I made weak models do
  my implementation work" or the events.jsonl architecture write-up.

## Phase 3 — post-launch

- Ship visibly weekly for 6–8 weeks; fast issue responses are the growth engine.
- YouTube / newsletter outreach only after HN social proof exists.
- Watch for the monetization signal (unsolicited team/support emails) before
  revisiting payment.

## Sources

- Vibe Kanban shutdown: https://www.vibekanban.com/blog/shutdown ·
  https://finance.biggo.com/news/59670028d308ba97 ·
  https://x.com/swyx/status/2050753293601935777
- Landscape: https://github.com/andyrewlee/awesome-agent-orchestrators ·
  https://www.augmentcode.com/tools/open-source-agent-orchestrators ·
  https://nimbalyst.com/blog/best-git-worktree-tools-ai-coding-2026/
- Spec-driven development: https://github.github.com/spec-kit/ ·
  https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html ·
  https://www.augmentcode.com/tools/best-spec-driven-development-tools
- Community sentiment: https://www.developersdigest.tech/blog/what-hacker-news-gets-right-about-ai-coding-agents-2026 ·
  https://news.ycombinator.com/item?id=48680842
