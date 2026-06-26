import type { ReactNode } from "react";

// Small uppercase section label (10px, letter-spaced). See gui/design-system/README.md §5.
export default function Overline({
  children,
  tone = "light",
  mt = "0",
  mb = "6px",
}: {
  children: ReactNode;
  tone?: "light" | "dark";
  mt?: string;
  mb?: string;
}) {
  return (
    <div
      style={{
        fontSize: 10,
        letterSpacing: "0.08em",
        color: tone === "dark" ? "#8a8f99" : "#565656",
        marginTop: mt,
        marginBottom: mb,
      }}
    >
      {children}
    </div>
  );
}
