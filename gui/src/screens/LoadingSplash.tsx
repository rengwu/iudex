import a from "../App.module.scss";

// First paint while the iudex-CLI capability check is still in flight — the GUI
// does nothing without the CLI, so it blocks on a bare splash.
export default function LoadingSplash() {
  return (
    <main className={a.app}>
      <div className={a.splash}>
        <h1 className={a.logo}>iudex</h1>
      </div>
    </main>
  );
}
