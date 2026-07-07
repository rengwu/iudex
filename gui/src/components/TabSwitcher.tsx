import type { CSSProperties, ReactNode } from "react";
import s from "./TabSwitcher.module.scss";

// Segmented switcher for 2–4 options, three variants (design-system §5):
// pill (default, gray value-picker) · mode (amber active + radiogroup, a
// persisted setting) · tabs (top-accent bar over a document body).
// A tab is either a bare value (label === value) or { label, value } when the
// rendered label should differ from the value reported to onChange — so the
// value can be an opaque id/enum/boolean while the label is a pretty node.
export type TabItem<V extends string | number | boolean = string> =
  | V
  | { label: ReactNode; value: V };

type Variant = "pill" | "mode" | "modeDark" | "tabs";
const isMode = (v: Variant) => v === "mode" || v === "modeDark";

function normalize<V extends string | number | boolean>(
  t: TabItem<V>,
): { label: ReactNode; value: V } {
  return typeof t === "object" ? t : { label: String(t), value: t };
}

export default function TabSwitcher<
  V extends string | number | boolean = string,
>({
  tabs,
  value,
  onChange,
  variant = "pill",
  ariaLabel,
  fontSize,
  stretch,
  style,
}: {
  tabs: TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  variant?: Variant;
  ariaLabel?: string;
  fontSize?: string;
  stretch?: boolean;
  style?: CSSProperties;
}) {
  const items = tabs.map(normalize);
  return (
    <div
      className={`${s.track} ${s[variant]} ${stretch ? s.stretch : ""}`}
      style={style}
      role={
        isMode(variant)
          ? "radiogroup"
          : variant === "tabs"
            ? "tablist"
            : undefined
      }
      aria-label={ariaLabel}
    >
      {items.map((t) => {
        const on = t.value === value;
        return (
          <button
            key={String(t.value)}
            type="button"
            className={`${s.seg} ${on ? s.on : ""}`}
            style={fontSize ? { fontSize } : undefined}
            onClick={() => onChange(t.value)}
            role={
              isMode(variant)
                ? "radio"
                : variant === "tabs"
                  ? "tab"
                  : undefined
            }
            aria-checked={isMode(variant) ? on : undefined}
            aria-selected={variant === "tabs" ? on : undefined}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
