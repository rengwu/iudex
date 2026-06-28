import s from "./SetupBanner.module.scss";

// App-wide nudge shown while the agent-command pool is empty, so any spawn path
// has a visible route to first-run setup. Click opens the onboarding popup.
export default function SetupBanner({ onClick }: { onClick: () => void }) {
  return (
    <div className={s.setupBanner} onClick={onClick} title="Open first-run setup">
      ⚠ No agent command configured — spawning agents will fail. Click to set one
      up.
    </div>
  );
}
