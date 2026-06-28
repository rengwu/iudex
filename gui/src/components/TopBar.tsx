import s from "./TopBar.module.scss";

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// The app-wide top bar: brand + the workspace picker (click to open a different
// folder; the title shows the full path and last sync time).
export default function TopBar({
  root,
  lastSync,
  onPick,
}: {
  root: string | null;
  lastSync: string;
  onPick: () => void;
}) {
  return (
    <header className={s.topbar}>
      <div className={s.brand}>
        <span className={s.brandDot} />
        <span className={s.brandName}>iudex</span>
      </div>
      <div
        className={s.wsPicker}
        onClick={onPick}
        title={`${root ?? ""}${lastSync ? ` · synced ${lastSync}` : ""}`}
      >
        <span className={s.wsTag}>WS</span>
        <span className={s.wsPath}>{root ? basename(root) : ""}</span>
        <span className={s.wsChev}>▾</span>
      </div>
      <div className={s.spacer} />
    </header>
  );
}
