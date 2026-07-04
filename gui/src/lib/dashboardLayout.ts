import { useCallback, useEffect, useState } from "react";

// The Dashboard's free-arrangement canvas layout: {x,y,w,h,z} per panel, kept in
// React state (updated live during drag/resize) and persisted to localStorage,
// keyed by workspace root. Pure UI preference — no config, no CLI, no .iudex/
// files. Mirrors the project's hook idioms (see lib/worktrees.ts).

export type PanelBox = { x: number; y: number; w: number; h: number; z: number };
export type Layout = Record<string, PanelBox>; // keyed by panel id

export const PANEL_IDS = ["now", "pipe", "start", "shells", "auto", "activity"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

const LAYOUT_VERSION = 1;
const keyFor = (root: string) => `iudex.dashboard.layout:${root}`;

// Default arrangement — transcribes today's grid (NOW and PIPELINE full-width
// bands; then START-over-SHELLS in column 1, AUTOMATION in column 2, ACTIVITY in
// column 3). z ascends in render order. Sizes are not sacred; tune later.
export const DEFAULT_LAYOUT: Layout = {
  now: { x: 8, y: 8, w: 1184, h: 88, z: 1 },
  pipe: { x: 8, y: 104, w: 1184, h: 280, z: 2 },
  start: { x: 8, y: 392, w: 388, h: 150, z: 3 },
  shells: { x: 8, y: 550, w: 388, h: 150, z: 4 },
  auto: { x: 404, y: 392, w: 388, h: 308, z: 5 },
  activity: { x: 800, y: 392, w: 388, h: 308, z: 6 },
};

// Per-panel minimum sizes (Part C). Passed to each CanvasPanel as minW/minH so a
// panel can never be resized below the size its body can survive.
export const MIN_SIZE: Record<PanelId, { minW: number; minH: number }> = {
  now: { minW: 320, minH: 72 },
  pipe: { minW: 480, minH: 160 },
  start: { minW: 260, minH: 150 },
  shells: { minW: 220, minH: 110 },
  auto: { minW: 260, minH: 230 },
  activity: { minW: 260, minH: 150 },
};

const clone = (l: Layout): Layout =>
  Object.fromEntries(Object.entries(l).map(([id, b]) => [id, { ...b }]));

// Load the stored layout, version-gated and merged with defaults so a newly
// added panel gets a sane default without discarding the user's other positions.
// Any unknown stored id is ignored.
function loadLayout(root: string): Layout {
  let stored: Layout | null = null;
  try {
    const raw = localStorage.getItem(keyFor(root));
    if (raw) {
      const parsed = JSON.parse(raw) as { v?: number; panels?: Layout };
      if (parsed && parsed.v === LAYOUT_VERSION && parsed.panels) {
        stored = parsed.panels;
      }
    }
  } catch {
    // unparseable / unavailable → fall through to defaults
  }
  const out: Layout = {};
  for (const id of PANEL_IDS) {
    out[id] = stored && stored[id] ? { ...stored[id] } : { ...DEFAULT_LAYOUT[id] };
  }
  return out;
}

export function useDashboardLayout(root: string): {
  layout: Layout;
  setBox: (id: PanelId, box: PanelBox) => void;
  commit: () => void;
  bringToFront: (id: PanelId) => void;
  reset: () => void;
} {
  const [layout, setLayout] = useState<Layout>(() => loadLayout(root));

  // Re-load when the workspace root changes.
  useEffect(() => {
    setLayout(loadLayout(root));
  }, [root]);

  const persist = useCallback(
    (l: Layout) => {
      try {
        localStorage.setItem(keyFor(root), JSON.stringify({ v: LAYOUT_VERSION, panels: l }));
      } catch {
        // private-mode quotas etc. — a failed write must never break the view.
      }
    },
    [root],
  );

  // Live update (no persist) — called on every pointer-move for smooth rendering.
  const setBox = useCallback((id: PanelId, box: PanelBox) => {
    setLayout((l) => ({ ...l, [id]: box }));
  }, []);

  // Persist the current layout — called on pointer-up only (debounced to the end
  // of an interaction).
  const commit = useCallback(() => {
    setLayout((l) => {
      persist(l);
      return l;
    });
  }, [persist]);

  const bringToFront = useCallback(
    (id: PanelId) => {
      setLayout((l) => {
        const top = Math.max(...Object.values(l).map((b) => b.z));
        if (l[id].z === top) return l; // already frontmost — no-op, no write
        const next = { ...l, [id]: { ...l[id], z: top + 1 } };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const reset = useCallback(() => {
    const next = clone(DEFAULT_LAYOUT);
    setLayout(next);
    try {
      localStorage.removeItem(keyFor(root));
    } catch {
      // ignore
    }
  }, [root]);

  return { layout, setBox, commit, bringToFront, reset };
}
