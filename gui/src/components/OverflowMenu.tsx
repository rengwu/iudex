import { useEffect, useRef, useState, type ReactNode } from "react";
import s from "./OverflowMenu.module.scss";

// The shared "⋮ more actions" overflow menu — the single home for tucked-away
// (often destructive) actions, so they stay a deliberate reach rather than
// one-click reflexes on a toolbar. Opens on click, closes on outside-click or
// after any item pick. `direction` flips it up (for a menu anchored at the
// bottom of a panel, e.g. a footer) vs down (a header); `size` matches the
// trigger's height to its neighbouring buttons (sm 20px / md 24px).
export default function OverflowMenu({
  children,
  direction = "down",
  size = "md",
  title = "more actions",
  disabled,
}: {
  children: ReactNode;
  direction?: "up" | "down";
  size?: "sm" | "md";
  title?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className={s.wrap} ref={ref}>
      <button
        className={`${s.btn} ${s[size]}`}
        onClick={() => setOpen((o) => !o)}
        title={title}
        disabled={disabled}
      >
        ⋮
      </button>
      {open && (
        <div
          className={`${s.menu} ${s[direction]}`}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// A menu row — a full-width button; `danger` tints it red for destructive
// actions (Remove, Kill agent, Restart clean …).
export function OverflowItem({
  children,
  onClick,
  danger,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      className={`${s.item} ${danger ? s.danger : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
