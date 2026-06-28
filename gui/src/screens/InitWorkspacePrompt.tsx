import s from "./screens.module.scss";

// The opened folder isn't an iudex workspace yet: offer to initialize it in
// place, or pick a different folder. App wraps this in the <main> app frame.
export default function InitWorkspacePrompt({
  initing,
  error,
  onInit,
  onPickOther,
}: {
  initing: boolean;
  error: string | null;
  onInit: () => void;
  onPickOther: () => void;
}) {
  return (
    <div className={s.splash}>
      <p className={s.notWs}>not an iudex workspace</p>
      <button className={s.openBtn} disabled={initing} onClick={onInit}>
        {initing ? "Initializing…" : "Initialize"}
      </button>
      <button className={s.linkBtn} onClick={onPickOther}>
        open a different folder
      </button>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
