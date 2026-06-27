import { type ReactNode } from "react";
import a from "../App.module.scss";

// No workspace open yet: pick a folder to drive, or jump straight into first-run
// agent setup. The onboarding popup (when open) renders over this splash.
export default function WorkspaceSplash({
  iudexVersion,
  guiVersion,
  error,
  onPick,
  onSetupAgents,
  onboarding,
}: {
  iudexVersion: string | null;
  guiVersion: string;
  error: string | null;
  onPick: () => void;
  onSetupAgents: () => void;
  onboarding?: ReactNode;
}) {
  return (
    <main className={a.app}>
      <div className={a.splash}>
        <h1 className={a.logo}>iudex</h1>
        <button className={a.openBtn} onClick={onPick}>
          Open Folder
        </button>
        <button className={a.linkBtn} onClick={onSetupAgents}>
          Set up agents
        </button>
        <div className={a.versions}>
          <span>{iudexVersion ?? "iudex —"}</span>
          <span>gui {guiVersion}</span>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
      {onboarding}
    </main>
  );
}
