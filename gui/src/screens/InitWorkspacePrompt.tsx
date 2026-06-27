import a from "../App.module.scss";

// The opened folder isn't an iudex workspace yet: offer to initialize it in
// place, or pick a different folder.
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
    <main className={a.app}>
      <div className={a.splash}>
        <p className={a.notWs}>not an iudex workspace</p>
        <button className={a.openBtn} disabled={initing} onClick={onInit}>
          {initing ? "Initializing…" : "Initialize"}
        </button>
        <button className={a.linkBtn} onClick={onPickOther}>
          open a different folder
        </button>
        {error && <div className="error">{error}</div>}
      </div>
    </main>
  );
}
