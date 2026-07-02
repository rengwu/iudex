import Badge from "../components/Badge";
import Button from "../components/Button";
import s from "./screens.module.scss";

// Hard blocking screen: the iudex CLI can't be found. The GUI drives iudex the
// way a git client drives git, so without it nothing works — recover by pointing
// the GUI at a binary (Settings) or putting one on PATH, then re-check.
export default function CliUnavailableScreen({
  iudexErr,
  checking,
  onRecheck,
  onOpenSettings,
}: {
  iudexErr: string;
  checking: boolean;
  onRecheck: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className={s.splash} data-tauri-drag-region>
      <section className={s.errPanel}>
        <header className={s.errHead}>
          <span className={s.errBrand}>
            <span className={s.errDot} />
            iudex
          </span>
          <Badge bg="#e0584c" fg="#ffffff">
            CLI unavailable
          </Badge>
        </header>

        <div className={s.errBody}>
          <p className={s.errLede}>
            The iudex command-line tool isn’t available.
          </p>
          <pre className={s.errCode}>{iudexErr}</pre>
          <p className={s.errHint}>
            iudex drives this app the way git drives a git client. Install the{" "}
            <code>iudex</code> binary and point the GUI at it — set the path in
            Settings, or put <code>iudex</code> on your PATH (or set{" "}
            <code>IUDEX_BIN</code>) and re-check.
          </p>
        </div>

        <footer className={s.errActions}>
          <Button variant="quiet" disabled={checking} onClick={onRecheck}>
            {checking ? "Checking…" : "Re-check"}
          </Button>
          <Button variant="primary" onClick={onOpenSettings}>
            Open Settings
          </Button>
        </footer>
      </section>
    </div>
  );
}
