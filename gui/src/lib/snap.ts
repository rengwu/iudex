import type { PanelBox } from "./dashboardLayout";

// Drop-time snapping for the Dashboard canvas: a moving/resizing panel's edges
// snap to other panels' edges and the visible viewport edges, leaving a slight
// gap. Silent — no guide lines. Operates on each axis independently. Snapping is
// an assist applied during the interaction, never a live binding, so a later
// viewport resize re-aligns nothing.

export const SNAP_GAP = 8; // the "slight gap" left between snapped panels
export const SNAP_THRESHOLD = 8; // max px distance at which a snap engages

export type Dir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export type ViewportEdges = { left: number; right: number; top: number; bottom: number };

// Best single delta to shift the moving edges by so one of them lands on a target
// line within `threshold`; 0 if none is close enough. Nearest wins.
function snap1D(movingEdges: number[], targets: number[], threshold: number): number {
  let best = 0;
  let bestDist = threshold + 1;
  for (const edge of movingEdges) {
    for (const t of targets) {
      const d = t - edge;
      const ad = Math.abs(d);
      if (ad <= threshold && ad < bestDist) {
        best = d;
        bestDist = ad;
      }
    }
  }
  return best;
}

// The candidate lines an edge may snap to, built from the other panels and the
// visible viewport edges (all in canvas coords). Each neighbour contributes its
// two edges (align) plus a gap-offset line on each side (sit beside it).
function targetLines(others: PanelBox[], vp: ViewportEdges): { x: number[]; y: number[] } {
  const x: number[] = [vp.left, vp.right];
  const y: number[] = [vp.top, vp.bottom];
  for (const m of others) {
    x.push(m.x, m.x + m.w, m.x - SNAP_GAP, m.x + m.w + SNAP_GAP);
    y.push(m.y, m.y + m.h, m.y - SNAP_GAP, m.y + m.h + SNAP_GAP);
  }
  return { x, y };
}

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
  const { x: xt, y: yt } = targetLines(others, vp);
  let { x, y, w, h } = b;

  if (mode === "move") {
    x += snap1D([x, x + w], xt, T);
    y += snap1D([y, y + h], yt, T);
    return { x, y, w, h, z: b.z };
  }

  // Resize: only the dragged edges are "moving".
  if (mode.includes("e")) w += snap1D([x + w], xt, T);
  if (mode.includes("w")) {
    const dx = snap1D([x], xt, T);
    x += dx;
    w -= dx;
  }
  if (mode.includes("s")) h += snap1D([y + h], yt, T);
  if (mode.includes("n")) {
    const dy = snap1D([y], yt, T);
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
  return { x, y, w, h, z: b.z };
}
