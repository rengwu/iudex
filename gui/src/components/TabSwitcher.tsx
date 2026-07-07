import type { CSSProperties, ReactNode } from "react";
import s from "./TabSwitcher.module.scss";

// Segmented switcher for 2–4 options, variants (design-system §5):
// pill (default, gray value-picker) · mode/modeDark (amber active + radiogroup,
// a persisted setting) · tabs/tabsDark (top-accent bar over a body; tabsDark is
// the dark, mint-accented terminal chrome). Pass onClose to make tabs closable
// (a per-tab ✕ + middle-click) — the Terminal's dynamic session tabs.
// A tab is either a bare value (label === value) or { label, value } when the
// rendered label should differ from the value reported to onChange — so the
// value can be an opaque id/enum/boolean while the label is a pretty node.
export type TabItem<V extends string | number | boolean = string> =
  | V
  | { label: ReactNode; value: V };

type Variant = "pill" | "mode" | "modeDark" | "tabs" | "tabsDark";
const isMode = (v: Variant) => v === "mode" || v === "modeDark";
const isTabs = (v: Variant) => v === "tabs" || v === "tabsDark";

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
  onClose,
  closeTitle = "close",
  style,
}: {
  tabs: TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  variant?: Variant;
  ariaLabel?: string;
  fontSize?: string;
  stretch?: boolean;
  // When set, tabs become closable: a per-tab ✕ and middle-click both fire it.
  onClose?: (value: V) => void;
  closeTitle?: string;
  style?: CSSProperties;
}) {
  const items = tabs.map(normalize);
  return (
    <div
      className={`${s.track} ${s[variant]} ${stretch ? s.stretch : ""}`}
      style={style}
      role={isMode(variant) ? "radiogroup" : isTabs(variant) ? "tablist" : undefined}
      aria-label={ariaLabel}
    >
      {items.map((t) => {
        const on = t.value === value;
        const segRole = isMode(variant) ? "radio" : isTabs(variant) ? "tab" : undefined;
        const segCls = `${s.seg} ${on ? s.on : ""}`;
        const segStyle = fontSize ? { fontSize } : undefined;

        // Closable form: a container (not a <button>, so the ✕ button can live
        // inside it as a valid sibling) that selects on click / Enter / Space,
        // and closes on the ✕ or a middle-click — like a browser/editor tab.
        if (onClose) {
          return (
            <div
              key={String(t.value)}
              className={`${segCls} ${s.closable}`}
              style={segStyle}
              role={segRole}
              aria-selected={isTabs(variant) ? on : undefined}
              tabIndex={0}
              onClick={() => onChange(t.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onChange(t.value);
                }
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(t.value);
                }
              }}
            >
              {t.label}
              <button
                type="button"
                className={s.close}
                title={closeTitle}
                aria-label={closeTitle}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.value);
                }}
              >
                ✕
              </button>
            </div>
          );
        }

        return (
          <button
            key={String(t.value)}
            type="button"
            className={segCls}
            style={segStyle}
            onClick={() => onChange(t.value)}
            role={segRole}
            aria-checked={isMode(variant) ? on : undefined}
            aria-selected={isTabs(variant) ? on : undefined}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
