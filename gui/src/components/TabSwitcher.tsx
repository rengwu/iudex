// Segmented pill switcher for 2–4 tab labels. See gui/design-system/README.md §5.
export default function TabSwitcher({
  tabs,
  value,
  onChange,
  fontSize = "12px",
  style,
}: {
  tabs: string[];
  value: string;
  onChange: (label: string) => void;
  fontSize?: string;
  style?: React.CSSProperties;
}) {
  const active = value || tabs[0] || "";
  return (
    <div style={{ display: "flex", background: "#929292", border: "1px solid #6f6f6f", padding: 1, ...style }}>
      {tabs.map((label) => {
        const on = label === active;
        return (
          <span
            key={label}
            onClick={() => onChange(label)}
            style={{
              padding: "1px 11px",
              borderRadius: 3,
              cursor: "pointer",
              WebkitUserSelect: "none",
              userSelect: "none",
              fontSize,
              background: on ? "#dadada" : "transparent",
              color: on ? "#2a2a2a" : "#565656",
            }}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}
