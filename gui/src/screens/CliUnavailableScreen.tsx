import Badge from "../components/Badge";
import Button from "../components/Button";
import a from "../App.module.scss";

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
    <main className={a.app}>
      <div className={a.splash}>
        <section className={a.errPanel}>
          <header className={a.errHead}>
            <span className={a.errBrand}>
              <span className={a.errDot} />
              iudex
            </span>
            <Badge bg="#e0584c" fg="#ffffff">
              CLI unavailable
            </Badge>
          </header>

          <div className={a.errBody}>
            <p className={a.errLede}>
              The iudex command-line tool isn’t available.
            </p>
            <pre className={a.errCode}>{iudexErr}</pre>
            <p className={a.errHint}>
              iudex drives this app the way git drives a git client. Install the{" "}
              <code>iudex</code> binary and point the GUI at it — set the path in
              Settings, or put <code>iudex</code> on your PATH (or set{" "}
              <code>IUDEX_BIN</code>) and re-check.
            </p>
          </div>

          <footer className={a.errActions}>
            <Button variant="quiet" disabled={checking} onClick={onRecheck}>
              {checking ? "Checking…" : "Re-check"}
            </Button>
            <Button variant="primary" onClick={onOpenSettings}>
              Open Settings
            </Button>
          </footer>
        </section>
      </div>
    </main>
  );
}
