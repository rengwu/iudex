import type { CSSProperties, ReactNode } from "react";

// Flat, square-cornered action button. Color = state.
// See gui/design-system/README.md §5.
type Variant = "primary" | "secondary" | "review" | "danger" | "quiet";
type Size = "sm" | "md";

const VARIANT: Record<Variant, { bg: string; col: string; border: string; weight: number }> = {
  primary: { bg: "#f4bc41", col: "#2a2a2a", border: "1px solid #c79320", weight: 500 },
  secondary: { bg: "#9c9c9c", col: "#2a2a2a", border: "1px solid #6f6f6f", weight: 400 },
  review: { bg: "#836ddd", col: "#ffffff", border: "none", weight: 500 },
  danger: { bg: "#e0584c", col: "#ffffff", border: "1px solid #b03d33", weight: 500 },
  quiet: { bg: "transparent", col: "#565656", border: "1px solid #6f6f6f", weight: 400 },
};

const SIZE: Record<Size, { h: string; pad: string }> = {
  sm: { h: "20px", pad: "0 9px" },
  md: { h: "22px", pad: "0 12px" },
};

export default function Button({
  children,
  variant = "secondary",
  size = "sm",
  onClick,
  title,
  disabled,
  style,
}: {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const v = VARIANT[variant];
  const s = SIZE[size];
  const small = variant === "quiet" || variant === "danger";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        whiteSpace: "nowrap",
        fontFamily: "var(--font-ui)",
        height: s.h,
        padding: small ? "0 8px" : s.pad,
        fontSize: small ? "11px" : "12px",
        fontWeight: v.weight,
        background: v.bg,
        color: v.col,
        border: v.border,
        borderRadius: 0,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  );
}
