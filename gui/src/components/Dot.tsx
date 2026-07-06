import s from "./Dot.module.scss";

// The one status dot (design-system §2.1): a circular colored fill inside a
// 1px neutral ring, so light fills hold their edge on gray panels and dark
// chrome alike. `size` is the fill diameter — the ring draws outside it.
// Color should come from the central registries (lib/badges.ts, VIEWS); omit
// `color` when CSS supplies the fill instead (currentColor tones, variant
// classes). `className` is for positional/animation extras only, never shape.
export default function Dot({
  color,
  size = 7,
  className,
  title,
}: {
  color?: string;
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={className ? `${s.dot} ${className}` : s.dot}
      style={{ width: size, height: size, background: color }}
      title={title}
    />
  );
}
