import s from "./screens.module.scss";

// No workspace open yet: pick a folder to drive, or jump straight into first-run
// agent setup. App wraps this in the <main> app frame (and renders the onboarding
// popup alongside it when open).
export default function WorkspaceSplash({
  iudexVersion,
  guiVersion,
  error,
  onPick,
  onSetupAgents,
}: {
  iudexVersion: string | null;
  guiVersion: string;
  error: string | null;
  onPick: () => void;
  onSetupAgents: () => void;
}) {
  return (
    <div className={s.splash}>
      <h1 className={s.logo}>iudex</h1>
      <button className={s.openBtn} onClick={onPick}>
        Open Folder
      </button>
      <button className={s.linkBtn} onClick={onSetupAgents}>
        Set up agents
      </button>
      <div className={s.versions}>
        <span>{iudexVersion ?? "iudex —"}</span>
        <span>gui {guiVersion}</span>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
