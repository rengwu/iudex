import { useRef } from "react";
import type { PanelBox, PanelId } from "../lib/dashboardLayout";
import { applySnap, type ViewportEdges } from "../lib/snap";
import s from "./CanvasPanel.module.scss";

// A draggable / resizable panel on the Dashboard free-arrangement canvas. Provides
// the chrome — a header grab handle, eight resize handles, absolute positioning —
// and reports geometry changes; it holds no layout state of its own (the store in
// lib/dashboardLayout.ts owns that). The body stays fully interactive: its
// buttons, inputs and lists work normally; only the header and handles drive
// move/resize. Pointer math works purely in deltas (immune to scroll).

type Dir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLES: Dir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

// Compute the next box from the interaction start + accumulated pointer delta,
// applying the min-size clamp. Edges that move the origin (n, w) stop moving it
// once clamped so the opposite edge stays put.
function nextBox(
  mode: "move" | Dir,
  start: PanelBox,
  dx: number,
  dy: number,
  minW: number,
  minH: number,
): PanelBox {
  if (mode === "move") return { ...start, x: start.x + dx, y: start.y + dy };

  let { x, y, w, h } = start;
  if (mode.includes("e")) w = Math.max(minW, start.w + dx);
  if (mode.includes("w")) {
    const right = start.x + start.w;
    w = Math.max(minW, start.w - dx);
    x = right - w;
  }
  if (mode.includes("s")) h = Math.max(minH, start.h + dy);
  if (mode.includes("n")) {
    const bottom = start.y + start.h;
    h = Math.max(minH, start.h - dy);
    y = bottom - h;
  }
  return { x, y, w, h, z: start.z };
}

export default function CanvasPanel({
  title,
  box,
  minW,
  minH,
  others,
  scrollRef,
  children,
  onChange,
  onCommit,
  onFocus,
}: {
  id: PanelId;
  title: string;
  box: PanelBox;
  minW: number;
  minH: number;
  others: PanelBox[]; // sibling boxes — snap targets
  scrollRef: React.RefObject<HTMLDivElement | null>; // canvas scroll container
  children: React.ReactNode;
  onChange: (b: PanelBox) => void;
  onCommit: () => void;
  onFocus: () => void;
}): React.JSX.Element {
  // Live interaction state kept in a ref — pointer handlers read/write it without
  // re-rendering; the visible geometry flows through onChange → the store. The
  // snap targets (siblings + viewport edges) are snapshotted at drag start.
  const drag = useRef<{
    mode: "move" | Dir;
    startX: number;
    startY: number;
    start: PanelBox;
    others: PanelBox[];
    vp: ViewportEdges;
  } | null>(null);

  // Visible viewport edges in canvas coords, read from the scroll container.
  const viewport = (): ViewportEdges => {
    const el = scrollRef.current;
    if (!el) return { left: 0, right: 0, top: 0, bottom: 0 };
    return {
      left: el.scrollLeft,
      right: el.scrollLeft + el.clientWidth,
      top: el.scrollTop,
      bottom: el.scrollTop + el.clientHeight,
    };
  };

  const begin = (mode: "move" | Dir) => (e: React.PointerEvent) => {
    if (e.button !== 0) return; // primary button only
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      start: box,
      others,
      vp: viewport(),
    };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const raw = nextBox(d.mode, d.start, dx, dy, minW, minH);
    onChange(applySnap(d.mode, raw, d.others, d.vp, minW, minH));
  };

  const end = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const b = applySnap(d.mode, nextBox(d.mode, d.start, dx, dy, minW, minH), d.others, d.vp, minW, minH);
    // Clamp top/left overflow back into the safe zone; bottom/right is left to
    // grow the canvas (scrollbars).
    onChange({ ...b, x: Math.max(0, b.x), y: Math.max(0, b.y) });
    onCommit();
    drag.current = null;
  };

  return (
    <section
      className={s.panel}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex: box.z }}
      onPointerDownCapture={onFocus}
    >
      <div
        className={s.header}
        onPointerDown={begin("move")}
        onPointerMove={move}
        onPointerUp={end}
      >
        <svg className={s.grip} width="6" height="14" viewBox="0 0 6 14" aria-hidden="true">
          <circle cx="1.5" cy="3" r="1" />
          <circle cx="4.5" cy="3" r="1" />
          <circle cx="1.5" cy="7" r="1" />
          <circle cx="4.5" cy="7" r="1" />
          <circle cx="1.5" cy="11" r="1" />
          <circle cx="4.5" cy="11" r="1" />
        </svg>
        <span className={s.title}>{title}</span>
      </div>
      <div className={s.body}>{children}</div>
      {HANDLES.map((dir) => (
        <div
          key={dir}
          className={`${s.handle} ${s[`h_${dir}`]}`}
          onPointerDown={begin(dir)}
          onPointerMove={move}
          onPointerUp={end}
        />
      ))}
    </section>
  );
}
