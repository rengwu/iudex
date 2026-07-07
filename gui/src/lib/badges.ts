// The single source of truth for every badge/chip color + label in the app.
// Consumed by the shared <Badge> component (filled pills) and, for color only,
// by the standalone dot indicators (Tickets rows, graph nodes, agent status).
// Color is state, not decoration — so it lives here, once.

export interface StateStyle {
  bg: string;
  fg: string;
  dot: string; // accent for bare dots (table rows, graph nodes)
  label: string; // full label (table / list)
  short: string; // compact label (graph node pill)
  dark?: { bg: string; fg: string }; // optional fill for dark surfaces (the graph)
}

// Ticket lifecycle states.
export const TICKET_STATE: Record<string, StateStyle> = {
  queued: {
    bg: "#828282",
    fg: "#e8e9eb",
    dot: "#9ea0e0",
    label: "queued",
    short: "queued",
    dark: { bg: "#3a3f4a", fg: "#cfcfcf" },
  },
  active: {
    bg: "#f4bc41",
    fg: "#2a2a2a",
    dot: "#f4bc41",
    label: "active",
    short: "active",
  },
  "pending-qa": {
    bg: "#5bc7d8",
    fg: "#10333a",
    dot: "#5bc7d8",
    label: "pending-qa",
    short: "pending-qa",
  },
  "pending-human-qa": {
    bg: "#836ddd",
    fg: "#ffffff",
    dot: "#836ddd",
    label: "pending-human-qa",
    short: "human-qa",
  },
  done: {
    bg: "#3b853d",
    fg: "#d1dad1",
    dot: "#5ccf5c",
    label: "done",
    short: "done",
    dark: { bg: "#243029", fg: "#5ccf5c" },
  },
  failed: {
    bg: "#e0584c",
    fg: "#ffffff",
    dot: "#e0584c",
    label: "failed",
    short: "failed",
  },
  removed: {
    bg: "#828282",
    fg: "#3d3b3b",
    dot: "#565656",
    label: "removed",
    short: "removed",
    dark: { bg: "#3a3f4a", fg: "#8a8f99" },
  },
};

const STATE_FALLBACK: StateStyle = {
  bg: "#828282",
  fg: "#e8e9eb",
  dot: "#8a8f99",
  label: "",
  short: "",
};

export function ticketState(state: string): StateStyle {
  return (
    TICKET_STATE[state] ?? { ...STATE_FALLBACK, label: state, short: state }
  );
}

// Bare state-dot color (Tickets table rows, graph nodes).
export function stateDot(state: string): string {
  return ticketState(state).dot;
}

// Merge-readiness badges (Review). Labels are dynamic (counts/glyphs), so the
// caller passes them as children; only the color is registered here.
export const MERGE: Record<string, { bg: string; fg: string }> = {
  clean: { bg: "#237723", fg: "#cee0ce" },
  conflicts: { bg: "#e6b54c", fg: "#3a2a00" },
  resolving: { bg: "#5bc7d8", fg: "#10333a" },
  // Resolver finished/crashed → the human's turn. Brighter amber than the
  // passive "conflicts predicted" badge, to read as a call to action.
  flagged: { bg: "#f4bc41", fg: "#3a2a00" },
};

// Agent role — monochrome for every role (label conveys the role, not color).
export const ROLE_STYLE = { bg: "#404040", fg: "#cfcfcf" };

// Synthesized agent status → its signal color (the standalone status dot).
export const AGENT_STATUS: Record<string, string> = {
  working: "#5ccf5c",
  idle: "#f4bc41",
  "awaiting-finish": "#f4bc41",
  "review-ready": "#836ddd",
  resolved: "#5ccf5c", // merge committed — success
  flagged: "#e6b54c", // conflicts left for a human (matches the Review conflict badge)
  crashed: "#e0584c",
  done: "#5ccf5c",
  gone: "#565656",
};

export function agentStatusColor(status: string): string {
  return AGENT_STATUS[status] ?? "#565656";
}
