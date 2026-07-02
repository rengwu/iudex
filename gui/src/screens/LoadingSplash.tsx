import s from "./screens.module.scss";

// First paint while the iudex-CLI capability check is still in flight — the GUI
// does nothing without the CLI, so it blocks on a bare splash. App wraps this in
// the <main> app frame.
export default function LoadingSplash() {
  return (
    <div className={s.splash} data-tauri-drag-region>
      <h1 className={s.brand}>iudex</h1>
    </div>
  );
}
