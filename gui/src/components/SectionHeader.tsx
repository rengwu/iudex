import type { ReactNode } from "react";

// Flush section-label strip at the top of a sidebar column.
// See gui/design-system/README.md §5.
export default function SectionHeader({
  children,
  tone = "light",
  pad,
  noBorder,
  borderTop,
}: {
  children: ReactNode;
  tone?: "light" | "dark";
  pad?: string;
  noBorder?: boolean;
  borderTop?: boolean;
}) {
  const dark = tone === "dark";
  const bc = dark ? "#14171d" : "#6f6f6f";
  return (
    <div
      style={{
        fontSize: 10,
        letterSpacing: "0.08em",
        color: dark ? "#8a8f99" : "#3a3a3a",
        padding: pad ?? (dark ? "11px 11px 5px" : "8px 11px 5px"),
        borderBottom: noBorder ? "none" : `1px solid ${bc}`,
        borderTop: borderTop ? `1px solid ${bc}` : "none",
      }}
    >
      {children}
    </div>
  );
}
