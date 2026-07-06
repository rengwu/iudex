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
  // This bar doubles as the window's title bar: it's the drag region (macOS
  // titleBarStyle=Overlay keeps the native traffic lights floating top-left, so
  // .topbar reserves left padding for them). Interactive children (the WS
  // picker) opt out of dragging by simply not carrying the attribute.
  return (
    <header className={s.topbar} data-tauri-drag-region>
      <div className={s.brand} data-tauri-drag-region>
        <span className={s.brandName} data-tauri-drag-region>
          iudex
        </span>
      </div>
      <div
        className={s.wsPicker}
        onClick={onPick}
        title={`${root ?? ""}${lastSync ? ` · synced ${lastSync}` : ""}`}
      >
        <span className={s.wsTag}>WORKSPACE</span>
        <span className={s.wsPath}>{root ? basename(root) : ""}</span>
        <span className={s.wsChev}>▾</span>
      </div>
      <div className={s.spacer} data-tauri-drag-region />
    </header>
  );
}
