import type { ReactNode } from "react";

// 30px header bar at the top of every main view (gui/design-system/README.md §5).
// `children` is the right-aligned action slot.
export default function ViewHeader({
  dot,
  title,
  subtitle,
  children,
}: {
  dot: string;
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        height: 30,
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "0 12px",
        background: "#afafaf",
        borderBottom: "1px solid #6f6f6f",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flex: "none" }} />
      <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
      {subtitle && <span style={{ fontSize: 11, color: "#565656" }}>{subtitle}</span>}
      <span style={{ flex: 1 }} />
      {children}
    </div>
  );
}
