import { useMemo, useState } from "react";
import type { Ticket } from "../types";
import { stateDot, ticketState } from "../lib/badges";
import Badge from "../components/Badge";

const NW = 178;
const NH = 64;
const COL = 234;
const ROW = 92;

// Auto-layered DAG: x = longest-path depth, y = stacking within the layer.
function layout(tickets: Ticket[]): Record<string, { x: number; y: number }> {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 0; // cycle guard (shouldn't happen — deps are a DAG)
    visiting.add(id);
    const t = byId.get(id);
    const d = !t || t.deps.length === 0 ? 0 : 1 + Math.max(...t.deps.map(depthOf));
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  tickets.forEach((t) => depthOf(t.id));
  const perLayer = new Map<number, number>();
  const pos: Record<string, { x: number; y: number }> = {};
  for (const t of tickets) {
    const d = depth.get(t.id) ?? 0;
    const i = perLayer.get(d) ?? 0;
    perLayer.set(d, i + 1);
    pos[t.id] = { x: 30 + d * COL, y: 30 + i * ROW };
  }
  return pos;
}

export default function TicketGraph({
  tickets,
  titles,
  selId,
  onSelect,
}: {
  tickets: Ticket[];
  titles: Record<string, string>;
  selId: string | null;
  onSelect: (id: string) => void;
}) {
  const base = useMemo(() => layout(tickets), [tickets]);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});

  const posOf = (id: string) => moved[id] ?? base[id] ?? { x: 30, y: 30 };

  const startDrag = (onMove: (dx: number, dy: number) => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: MouseEvent) => onMove(ev.clientX - sx, ev.clientY - sy);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Capture the pan at gesture start so the running delta is absolute, not cumulative.
  const panDown = (e: React.MouseEvent) => {
    const p0 = { ...pan };
    startDrag((dx, dy) => setPan({ x: p0.x + dx, y: p0.y + dy }))(e);
  };
  const nodeDown = (id: string) => (e: React.MouseEvent) => {
    const o = posOf(id);
    startDrag((dx, dy) => setMoved((m) => ({ ...m, [id]: { x: o.x + dx, y: o.y + dy } })))(e);
  };

  const byId = new Map(tickets.map((t) => [t.id, t]));
  const edges: { d: string; color: string; dash: string; x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const t of tickets) {
    for (const dep of t.deps) {
      const a = posOf(dep);
      const b = posOf(t.id);
      if (!a || !b) continue;
      const x1 = a.x + NW;
      const y1 = a.y + NH / 2;
      const x2 = b.x;
      const y2 = b.y + NH / 2;
      const mx = (x1 + x2) / 2;
      const satisfied = byId.get(dep)?.state === "done";
      edges.push({
        d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
        color: satisfied ? "#5ccf5c" : "#d99a3c",
        dash: satisfied ? "0" : "5 4",
        x1, y1, x2, y2,
      });
    }
  }

  const legendItem = (sw: React.ReactNode, label: string) => (
    <span style={{ fontSize: 10, color: "#8a8f99", display: "flex", alignItems: "center", gap: 5 }}>
      {sw}
      {label}
    </span>
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        position: "relative",
        overflow: "hidden",
        height: "100%",
        cursor: "grab",
        backgroundColor: "#1d1d1d",
        // Grid lives on the viewport-sized container and scrolls via
        // background-position, so it tiles infinitely under any pan.
        backgroundImage:
          "linear-gradient(#2b2f38 1px, transparent 1px), linear-gradient(90deg, #2b2f38 1px, transparent 1px)",
        backgroundSize: "22px 22px",
        backgroundPosition: `${pan.x}px ${pan.y}px`,
      }}
      onMouseDown={panDown}
    >
      <div style={{ position: "absolute", top: 10, right: 12, zIndex: 5, display: "flex", gap: 14, alignItems: "center" }}>
        {legendItem(<span style={{ width: 14, height: 2, background: "#5ccf5c" }} />, "satisfied")}
        {legendItem(<span style={{ width: 14, height: 0, borderTop: "2px dashed #d99a3c" }} />, "blocking")}
        <span
          onClick={(e) => {
            e.stopPropagation();
            setPan({ x: 0, y: 0 });
            setMoved({});
          }}
          style={{ fontSize: 11, whiteSpace: "nowrap", color: "#8ce8fa", background: "#20242e", border: "1px solid #3a3f4a", padding: "3px 9px", cursor: "pointer" }}
        >
          Reset layout
        </span>
      </div>

      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 1400,
          height: 900,
          transform: `translate(${pan.x}px, ${pan.y}px)`,
        }}
      >
        <svg style={{ position: "absolute", top: 0, left: 0, width: 1400, height: 900, pointerEvents: "none", overflow: "visible" }}>
          {edges.map((e, i) => (
            <g key={i}>
              <path fill="none" d={e.d} style={{ stroke: e.color, strokeWidth: "1.6px", strokeDasharray: e.dash, opacity: 0.92 }} />
              <circle r="3" cx={e.x1} cy={e.y1} style={{ fill: e.color }} />
              <circle r="3" cx={e.x2} cy={e.y2} style={{ fill: e.color }} />
            </g>
          ))}
        </svg>
        {tickets.map((t) => {
          const p = posOf(t.id);
          const on = t.id === selId;
          return (
            <div
              key={t.id}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onSelect(t.id)}
              style={{
                position: "absolute",
                width: NW,
                left: p.x,
                top: p.y,
                background: "#20242e",
                border: `1px solid ${on ? "#1f2e90" : "#14171d"}`,
                borderRadius: 2,
                boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
                userSelect: "none",
                cursor: "pointer",
              }}
            >
              <div
                onMouseDown={nodeDown(t.id)}
                style={{
                  height: 24,
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "0 8px",
                  background: on ? "#1f2e90" : "#2f333c",
                  borderBottom: "1px solid #14171d",
                  borderRadius: "2px 2px 0 0",
                  cursor: "grab",
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: stateDot(t.state), flex: "none" }} />
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 12, color: on ? "#fff" : "#e8e9eb" }}>
                  {t.id}
                </span>
                <span style={{ flex: 1 }} />
                <Badge kind="state" value={t.state} tone="dark">
                  {ticketState(t.state).short}
                </Badge>
              </div>
              <div style={{ padding: "6px 9px" }}>
                <div style={{ fontSize: 12, color: "#c9ccd1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {titles[t.worktree ?? ""] || t.id}
                </div>
                <div style={{ marginTop: 3, fontFamily: "var(--font-mono)", fontSize: 10, color: "#8a8f99" }}>
                  {t.deps.length ? `needs ${t.deps.join(" ")}` : t.state}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
