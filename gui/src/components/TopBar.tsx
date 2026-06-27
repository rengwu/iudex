import a from "../App.module.scss";

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
    <header className={a.topbar}>
      <div className={a.brand}>
        <span className={a.brandDot} />
        <span className={a.brandName}>iudex</span>
      </div>
      <div
        className={a.wsPicker}
        onClick={onPick}
        title={`${root ?? ""}${lastSync ? ` · synced ${lastSync}` : ""}`}
      >
        <span className={a.wsTag}>WS</span>
        <span className={a.wsPath}>{root ? basename(root) : ""}</span>
        <span className={a.wsChev}>▾</span>
      </div>
      <div className={a.spacer} />
    </header>
  );
}
