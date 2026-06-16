// The idea-shaping skills offered by the Tickets view's "New idea" launcher.
// This is the single place to configure them — add an entry (its slug must match
// a skill scaffolded under .iudex/skills/) and it appears in the dropdown. Each
// launches an agent preloaded with that skill at the workspace root; the agent
// drives the chain to `iudex queue` itself.
export interface IdeaSkill {
  slug: string;
  label: string;
  description: string;
}

export const IDEA_SKILLS: IdeaSkill[] = [
  {
    slug: "grill-me",
    label: "Grill me",
    description: "Stress-test a raw idea with relentless one-at-a-time questions.",
  },
  {
    slug: "grill-with-docs",
    label: "Grill with docs",
    description:
      "Same, but challenge the idea against .context/ glossary + ADRs and update them inline.",
  },
  {
    slug: "improve-codebase-architecture",
    label: "Improve architecture",
    description:
      "Find deepening / refactoring opportunities that feed back into the funnel.",
  },
];
