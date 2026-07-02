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
    <div className={s.splash} data-tauri-drag-region>
      <div className={s.card}>
        <div className={s.brand}>iudex</div>
        <div className={s.cardHead}>AI-native engineering workspace</div>
        <div className={s.cardBody}>
          <button className={s.openBtn} onClick={onPick}>
            <FolderIcon />
            Open Folder
          </button>
          <div className={s.cardDivider} />
          <button className={s.linkBtn} onClick={onSetupAgents}>
            <PlusIcon />
            Set up agents
          </button>
        </div>
        <div className={s.cardFoot}>
          <span>{iudexVersion ?? "iudex —"}</span>
          <span>gui {guiVersion}</span>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.5 3.5h4l1.5 1.5h7.5v8.5h-13z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 5v6M5 8h6" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
