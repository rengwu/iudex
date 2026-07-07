import type { CSSProperties, ReactNode } from "react";
import s from "./Button.module.scss";

// Flat, square-cornered action button. Color = state.
// See gui/design-system/README.md §5 and design-system/button-interaction-states.md.
// Styling (incl. hover/active/focus-visible) lives in Button.module.scss; this
// component just maps the variant/size props to classes. Size is decoupled from
// variant — every variant honours the same sm/md geometry.
export type Variant =
  | "primary"
  | "secondary"
  | "review"
  | "danger"
  | "success"
  | "info"
  | "quiet"
  | "quietDark";
type Size = "sm" | "md" | "lg";

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
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`${s.btn} ${s[size]} ${s[variant]}`}
      style={style}
    >
      {children}
    </button>
  );
}
