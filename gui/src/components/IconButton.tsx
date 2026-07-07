import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import s from "./IconButton.module.scss";

// The one bare glyph button: close / dismiss / kill. Glyph-only (defaults to ✕);
// labeled nav like Settings' "← Back" stays a plain text link, not this.
// Color is inherited from the surface at reduced opacity → brightens on hover;
// tone="danger" turns the hover red (destructive). See design-system §5.
export default function IconButton({
  onClick,
  title,
  tone = "neutral",
  size = "md",
  disabled,
  children,
  style,
}: {
  onClick?: MouseEventHandler<HTMLButtonElement>;
  title?: string;
  tone?: "neutral" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      className={`${s.btn} ${s[size]} ${s[tone]}`}
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={style}
    >
      {children ?? "✕"}
    </button>
  );
}
