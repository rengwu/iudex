import { useState, type ReactNode } from "react";
import { type View } from "./types";
import { NavContext, useNavState } from "./lib/nav";
import { useSessions } from "./lib/sessions";
import { useWorkspace } from "./lib/workspace";
import { useIudexCheck } from "./lib/iudexCheck";
import { useViewKeepAlive } from "./lib/viewKeepAlive";
import { useAutomation } from "./lib/automation";
import { useOnboarding } from "./lib/onboarding";
import Dashboard from "./views/Dashboard";
import Tickets from "./views/Tickets";
import Specifications from "./views/Specifications";
import Terminal from "./views/Terminal";
import Agents from "./views/Agents";
import Worktrees from "./views/Worktrees";
import Review from "./views/Review";
import Archive from "./views/Archive";
import Settings from "./views/Settings";
import Onboarding from "./views/Onboarding";
import LoadingSplash from "./screens/LoadingSplash";
import CliUnavailableScreen from "./screens/CliUnavailableScreen";
import WorkspaceSplash from "./screens/WorkspaceSplash";
import InitWorkspacePrompt from "./screens/InitWorkspacePrompt";
import Sidebar from "./components/Sidebar";
import TopBar from "./components/TopBar";
import SetupBanner from "./components/SetupBanner";
import "./styles/base.scss";
import a from "./App.module.scss";

// GUI version: no real versioning scheme yet — placeholder until we wire one up
// (e.g. inject from package.json / git at build time, like the iudex binary).
const GUI_VERSION = "dev";

export default function App() {
  // iudex CLI availability gates the whole app (recovery via the splash below).
  const {
    version: iudexVersion,
    error: iudexErr,
    checking: checkingIudex,
    recheck: checkIudex,
  } = useIudexCheck();
  // Standalone (workspace-less) Settings opened from the missing-binary splash,
  // so the user can point the GUI at an iudex binary and recover in place.
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);

  // Workspace data layer: open/init, status --json, events.jsonl doorbell.
  const {
    root,
    ws,
    error,
    setError,
    offerInit,
    initing,
    lastSync,
    pickAndOpen,
    initHere,
    load,
  } = useWorkspace();

  // Cross-view navigation: current view + a per-view pending-focus map. Source
  // components call goTo(view, focus); targets read it via usePendingFocus.
  // Land on Tickets: the Dashboard reskin is deferred (still the old dark style).
  const { view, setView, value: nav } = useNavState("tickets");

  // Views stay mounted after switch-away (state intact); pruned after inactivity.
  const mounted = useViewKeepAlive(view);
  const { sessions } = useSessions(root);
  // Opt-in auto-activate / auto-QA drains + the steady-cadence poll.
  const {
    autoActivate,
    autoQA,
    autoRetire,
    autoResolve,
    resolveStatus,
    sequential,
    toggleAutoActivate,
    toggleAutoQA,
    toggleAutoRetire,
    toggleAutoResolve,
    toggleSequential,
  } = useAutomation(root, ws, sessions, load, setError);

  // First-run agent setup, gated on the CLI being reachable (the read shells
  // `iudex config --json`).
  const { poolEmpty, showOnboarding, openOnboarding, closeOnboarding } =
    useOnboarding(!!iudexVersion && !iudexErr);
  const onboarding = showOnboarding ? (
    <Onboarding onClose={closeOnboarding} />
  ) : null;

  // ── First paint blocks on the iudex check; the GUI does nothing without it ──
  // The screen states render only their inner content; App owns the <main> frame.
  if (checkingIudex && !iudexVersion && !iudexErr) {
    return (
      <main className={a.app}>
        <LoadingSplash />
      </main>
    );
  }

  // ── Standalone Settings (no workspace): recover the binary path from here ────
  if (showGlobalSettings) {
    return (
      <main className={a.app}>
        <Settings
          root={null}
          onConfigSaved={() => {}}
          onClose={() => {
            setShowGlobalSettings(false);
            checkIudex();
          }}
        />
      </main>
    );
  }

  // ── iudex CLI missing: the GUI can't function without it ────────────────────
  // Guard on the error alone (not !checkingIudex) so the screen stays mounted
  // during a Re-check — checkIudex keeps iudexErr until the new result lands —
  // making the button's disabled/"Checking…" state live instead of a flicker.
  if (iudexErr) {
    return (
      <main className={a.app}>
        <CliUnavailableScreen
          iudexErr={iudexErr}
          checking={checkingIudex}
          onRecheck={checkIudex}
          onOpenSettings={() => setShowGlobalSettings(true)}
        />
      </main>
    );
  }

  // ── Splash: no workspace open yet ──────────────────────────────────────────
  if (!root && !offerInit) {
    return (
      <main className={a.app}>
        <WorkspaceSplash
          iudexVersion={iudexVersion}
          guiVersion={GUI_VERSION}
          error={error}
          onPick={pickAndOpen}
          onSetupAgents={openOnboarding}
        />
        {onboarding}
      </main>
    );
  }

  // ── Not a workspace: offer to initialize ───────────────────────────────────
  if (offerInit) {
    return (
      <main className={a.app}>
        <InitWorkspacePrompt
          initing={initing}
          error={error}
          onInit={initHere}
          onPickOther={pickAndOpen}
        />
      </main>
    );
  }

  // ── Workspace open ─────────────────────────────────────────────────────────
  // Render a view inside a keep-alive host: present while mounted (or active),
  // shown only when it's the current view, hidden (not unmounted) otherwise.
  const renderView = (id: View, node: ReactNode) =>
    id === view || mounted.includes(id) ? (
      <div
        key={id}
        className={a.viewHost}
        style={{ display: view === id ? "block" : "none" }}
      >
        {node}
      </div>
    ) : null;

  return (
    <main className={a.app}>
      <TopBar root={root} lastSync={lastSync} onPick={pickAndOpen} />

      {poolEmpty && <SetupBanner onClick={openOnboarding} />}

      {root && ws && (
        <NavContext.Provider value={nav}>
          <div className={a.body}>
            <Sidebar
              ws={ws}
              sessions={sessions}
              view={view}
              setView={setView}
              automation={{
                autoActivate,
                autoQA,
                autoRetire,
                autoResolve,
                resolveStatus,
                sequential,
                toggleAutoActivate,
                toggleAutoQA,
                toggleAutoRetire,
                toggleAutoResolve,
                toggleSequential,
              }}
            />

            <section className={a.main}>
              {error && <div className="error">{error}</div>}
              {renderView("dashboard", <Dashboard />)}
              {renderView(
                "tickets",
                <Tickets ws={ws} root={root} sequential={sequential} />,
              )}
              {renderView("specifications", <Specifications root={root} />)}
              {renderView(
                "terminal",
                <Terminal root={root} visible={view === "terminal"} />,
              )}
              {renderView("agents", <Agents ws={ws} root={root} />)}
              {renderView(
                "worktrees",
                <Worktrees ws={ws} root={root} />,
              )}
              {renderView("review", <Review ws={ws} root={root} />)}
              {renderView("archive", <Archive root={root} />)}
              {renderView(
                "settings",
                <Settings root={root} onConfigSaved={() => load(root)} />,
              )}
            </section>
          </div>
        </NavContext.Provider>
      )}
      {onboarding}
    </main>
  );
}
