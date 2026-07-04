import type { PanelBox } from "./dashboardLayout";

// Drop-time snapping for the Dashboard canvas. Silent — no guide lines. Each axis
// snaps independently, and the snap is an assist applied during the interaction,
// never a live binding, so a later viewport resize re-aligns nothing.
//
// Every candidate is chosen per moving edge so we never produce a 0px contact:
//   • same-side alignment only — a left edge snaps to other left edges, a right
//     edge to other right edges (never left↔right, which would touch flush).
//   • adjacency always leaves a gap — a right edge sits SNAP_GAP left of a
//     neighbour's left edge; a left edge sits SNAP_GAP right of a neighbour's
//     right edge.
//   • a neighbour only contributes targets when it is actually near the dragged
//     box on the perpendicular axis — a far-apart panel snaps to nothing. (Its
//     x-edges count only when the two overlap vertically within PROXIMITY, its
//     y-edges only when they overlap horizontally.)
//   • viewport edges are gapped too, so a panel never slams flush to the wall.
// All results are rounded to whole pixels — fractional trackpad deltas otherwise
// leave panels on sub-pixel positions that shimmer between n and n+1.

export const SNAP_GAP = 8; // the gap left beside a neighbour / the wall
export const SNAP_THRESHOLD = 8; // max px distance at which a snap engages
export const PROXIMITY = 32; // perpendicular-axis nearness required to snap to a neighbour

export type Dir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export type ViewportEdges = { left: number; right: number; top: number; bottom: number };

type MovingEdge = { pos: number; targets: number[] };

// Best single delta to shift the moving edge(s) by so one lands on one of its own
// targets within `threshold`; 0 if none is close enough. Nearest wins.
function bestDelta(edges: MovingEdge[], threshold: number): number {
  let best = 0;
  let bestDist = threshold + 1;
  for (const { pos, targets } of edges) {
    for (const t of targets) {
      const d = t - pos;
      const ad = Math.abs(d);
      if (ad <= threshold && ad < bestDist) {
        best = d;
        bestDist = ad;
      }
    }
  }
  return best;
}

// Separation between two 1-D ranges: 0 if they overlap, else the gap between the
// nearest ends. Used to gate a neighbour's targets by perpendicular nearness.
function separation(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.max(a1, b1) - Math.min(a2, b2));
}

// Per-edge target lines for the box `b`, built from the near-enough panels and
// the visible viewport edges (all in canvas coords). Kept separate by edge so
// left/right (top/bottom) each only see their own kind of alignment plus a
// gapped adjacency line — and a neighbour only contributes an axis's targets
// when it sits within PROXIMITY of `b` on the perpendicular axis.
function targetLines(
  b: PanelBox,
  others: PanelBox[],
  vp: ViewportEdges,
): { left: number[]; right: number[]; top: number[]; bottom: number[] } {
  const left = [vp.left + SNAP_GAP];
  const right = [vp.right - SNAP_GAP];
  const top = [vp.top + SNAP_GAP];
  const bottom = [vp.bottom - SNAP_GAP];
  for (const m of others) {
    // x-edges (left/right) align/adjoin only to panels near vertically…
    if (separation(b.y, b.y + b.h, m.y, m.y + m.h) <= PROXIMITY) {
      left.push(m.x, m.x + m.w + SNAP_GAP); // align left-to-left · sit right of m
      right.push(m.x + m.w, m.x - SNAP_GAP); // align right-to-right · sit left of m
    }
    // …and y-edges (top/bottom) only to panels near horizontally.
    if (separation(b.x, b.x + b.w, m.x, m.x + m.w) <= PROXIMITY) {
      top.push(m.y, m.y + m.h + SNAP_GAP);
      bottom.push(m.y + m.h, m.y - SNAP_GAP);
    }
  }
  return { left, right, top, bottom };
}

const round = (b: PanelBox): PanelBox => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  w: Math.round(b.w),
  h: Math.round(b.h),
  z: b.z,
});

// Apply snapping to a box mid-interaction. `mode` is "move" or a resize
// direction. Re-clamps to min size afterward (origin-preserving for the n/w
// edges) so a snap can never shrink a panel below its minimum.
export function applySnap(
  mode: "move" | Dir,
  b: PanelBox,
  others: PanelBox[],
  vp: ViewportEdges,
  minW: number,
  minH: number,
): PanelBox {
  const T = SNAP_THRESHOLD;
  const tg = targetLines(b, others, vp);
  let { x, y, w, h } = b;

  if (mode === "move") {
    // Rigid move: both edges are candidates, but the single nearest delta shifts
    // the whole panel — so each edge only pulls toward its own kind of target.
    x += bestDelta([{ pos: x, targets: tg.left }, { pos: x + w, targets: tg.right }], T);
    y += bestDelta([{ pos: y, targets: tg.top }, { pos: y + h, targets: tg.bottom }], T);
    return round({ x, y, w, h, z: b.z });
  }

  // Resize: only the dragged edges move, each against its own targets.
  if (mode.includes("e")) w += bestDelta([{ pos: x + w, targets: tg.right }], T);
  if (mode.includes("w")) {
    const dx = bestDelta([{ pos: x, targets: tg.left }], T);
    x += dx;
    w -= dx;
  }
  if (mode.includes("s")) h += bestDelta([{ pos: y + h, targets: tg.bottom }], T);
  if (mode.includes("n")) {
    const dy = bestDelta([{ pos: y, targets: tg.top }], T);
    y += dy;
    h -= dy;
  }

  // Re-clamp to min, keeping the non-dragged (opposite) edge put.
  if (w < minW) {
    if (mode.includes("w")) x = x + w - minW; // right edge stays
    w = minW;
  }
  if (h < minH) {
    if (mode.includes("n")) y = y + h - minH; // bottom edge stays
    h = minH;
  }
  return round({ x, y, w, h, z: b.z });
}
