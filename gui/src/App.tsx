import { useState, type ReactNode } from "react";
import { RAIL_VIEWS, RAIL_SECONDARY, type View } from "./types";
import { useSessions } from "./lib/sessions";
import { useWorkspace } from "./lib/workspace";
import { useIudexCheck } from "./lib/iudexCheck";
import { useViewKeepAlive } from "./lib/viewKeepAlive";
import { useAutomation } from "./lib/automation";
import { useOnboarding } from "./lib/onboarding";
import Dashboard from "./views/Dashboard";
import Tickets from "./views/Tickets";
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
import SectionHeader from "./components/SectionHeader";
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

  // Land on Tickets: the Dashboard reskin is deferred (still the old dark style).
  const [view, setView] = useState<View>("tickets");
  const [focusSession, setFocusSession] = useState<string | null>(null);
  const [focusTicket, setFocusTicket] = useState<string | null>(null);
  const [focusAgent, setFocusAgent] = useState<string | null>(null);
  // When set alongside focusAgent, the Agents view opens that agent on this tab.
  const [focusAgentTab, setFocusAgentTab] = useState<string | null>(null);

  // Views stay mounted after switch-away (state intact); pruned after inactivity.
  const mounted = useViewKeepAlive(view);
  const { sessions } = useSessions();
  // Opt-in auto-activate / auto-QA drains + the steady-cadence poll.
  const { autoActivate, autoQA, toggleAutoActivate, toggleAutoQA } =
    useAutomation(root, ws, sessions, load, setError);

  // First-run agent setup, gated on the CLI being reachable (the read shells
  // `iudex config --json`).
  const { poolEmpty, showOnboarding, openOnboarding, closeOnboarding } =
    useOnboarding(!!iudexVersion && !iudexErr);
  const onboarding = showOnboarding ? (
    <Onboarding onClose={closeOnboarding} />
  ) : null;

  // ── First paint blocks on the iudex check; the GUI does nothing without it ──
  if (checkingIudex && !iudexVersion && !iudexErr) {
    return <LoadingSplash />;
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
      <CliUnavailableScreen
        iudexErr={iudexErr}
        checking={checkingIudex}
        onRecheck={checkIudex}
        onOpenSettings={() => setShowGlobalSettings(true)}
      />
    );
  }

  // ── Splash: no workspace open yet ──────────────────────────────────────────
  if (!root && !offerInit) {
    return (
      <WorkspaceSplash
        iudexVersion={iudexVersion}
        guiVersion={GUI_VERSION}
        error={error}
        onPick={pickAndOpen}
        onSetupAgents={openOnboarding}
        onboarding={onboarding}
      />
    );
  }

  // ── Not a workspace: offer to initialize ───────────────────────────────────
  if (offerInit) {
    return (
      <InitWorkspacePrompt
        initing={initing}
        error={error}
        onInit={initHere}
        onPickOther={pickAndOpen}
      />
    );
  }

  // ── Workspace open ─────────────────────────────────────────────────────────
  const tickets = ws?.tickets ?? [];
  const cnt = (st: string) => tickets.filter((t) => t.state === st).length;
  const activeCount = cnt("active");
  const navCounts: Partial<Record<View, number>> = {
    terminal: sessions.filter((s) => s.kind !== "agent").length,
    tickets: tickets.filter((t) => t.state !== "removed" && t.state !== "done")
      .length,
    agents: sessions.filter((s) => s.kind === "agent").length,
    worktrees: new Set(
      tickets.filter((t) => t.hasWorktree && t.worktree).map((t) => t.worktree),
    ).size,
    review: cnt("pending-human-qa"),
  };
  const pipeline = [
    { n: cnt("queued"), label: "Queued", color: "#cfcfcf" },
    { n: activeCount, label: "Active", color: "#f4bc41" },
    { n: cnt("pending-qa"), label: "QA", color: "#5bc7d8" },
    { n: cnt("pending-human-qa"), label: "Review", color: "#836ddd" },
    { n: cnt("done"), label: "Merged", color: "#5ccf5c" },
  ];
  const maxActive = ws?.maxActive ?? 0;

  const navButton = (v: (typeof RAIL_VIEWS)[number]) => {
    const on = view === v.id;
    const count = navCounts[v.id];
    return (
      <button
        key={v.id}
        className={a.navItem}
        onClick={() => setView(v.id)}
        style={
          on
            ? {
                borderLeftColor: "#f4bc41",
                background: "#1f2e90",
                color: "#e8e9eb",
              }
            : undefined
        }
      >
        <span className={a.navDot} style={{ background: v.dot }} />
        <span className={a.navLabel}>{v.label}</span>
        {count !== undefined && count > 0 && (
          <span
            className={a.navCount}
            style={on ? { color: "#cdd2ff" } : undefined}
          >
            {count}
          </span>
        )}
      </button>
    );
  };

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
        <div className={a.body}>
          <nav className={a.rail}>
            <SectionHeader tone="dark" noBorder>
              BUILD
            </SectionHeader>
            {RAIL_VIEWS.map(navButton)}

            <SectionHeader tone="dark" noBorder>
              OTHERS
            </SectionHeader>

            {RAIL_SECONDARY.map(navButton)}

            <div className={a.railSpacer} />

            <div className={a.railBottom}>
              <div className={a.pipeline}>
                <div className={a.pipeTitle}>PIPELINE</div>
                <div className={a.pipeRows}>
                  {pipeline.map((p) => (
                    <div key={p.label} className={a.pipeRow}>
                      <span className={a.pipeNum} style={{ color: p.color }}>
                        {p.n}
                      </span>
                      <span className={a.pipeLabel}>{p.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className={a.transport}>
                <div className={a.transportBtns}>
                  <span
                    className={`${a.tBtn} ${autoActivate && autoQA ? a.tActive : ""}`}
                    title="Start automation (Auto-Activate + Auto-QA on)"
                    onClick={() => {
                      toggleAutoActivate(true);
                      toggleAutoQA(true);
                    }}
                  >
                    <span className={a.playTri} />
                  </span>
                  <span
                    className={`${a.tBtn} ${!autoActivate && !autoQA ? a.tActive : ""}`}
                    title="Stop automation (both off)"
                    onClick={() => {
                      toggleAutoActivate(false);
                      toggleAutoQA(false);
                    }}
                  >
                    <span className={a.stopSq} />
                  </span>
                </div>
                <div className={a.toggles}>
                  <div className={a.toggleRow}>
                    <span className={a.toggleLabel}>Auto-Activate</span>
                    <span
                      className={`${a.toggle} ${autoActivate ? a.toggleOn : a.toggleOff}`}
                      onClick={() => toggleAutoActivate(!autoActivate)}
                    >
                      <span className={a.knob} />
                    </span>
                  </div>
                  <div className={a.toggleRow}>
                    <span className={a.toggleLabel}>Auto-QA</span>
                    <span
                      className={`${a.toggle} ${autoQA ? a.toggleOn : a.toggleOff}`}
                      onClick={() => toggleAutoQA(!autoQA)}
                    >
                      <span className={a.knob} />
                    </span>
                  </div>
                </div>
              </div>

              <div className={a.sysinfo}>
                <div className={a.sysBranch}>{ws.mainBranch}</div>
                <div>
                  {activeCount}
                  {maxActive > 0 ? ` / ${maxActive}` : ""} active
                </div>
                <div>events.jsonl · live</div>
                {maxActive > 0 && (
                  <div className={a.sysBar}>
                    {Array.from({ length: maxActive }).map((_, i) => (
                      <span
                        key={i}
                        className={`${a.sysSeg} ${i < activeCount ? a.on : ""}`}
                      />
                    ))}
                  </div>
                )}
                {iudexVersion && (
                  <div className={a.sysVer} title={iudexVersion}>
                    {iudexVersion.replace(/^iudex /, "")}
                  </div>
                )}
              </div>
            </div>
          </nav>

          <section className={a.main}>
            {error && <div className="error">{error}</div>}
            {renderView("dashboard", <Dashboard />)}
            {renderView(
              "tickets",
              <Tickets
                ws={ws}
                root={root}
                onOpenInTerminal={(name) => {
                  setFocusSession(name);
                  setView("terminal");
                }}
                onJumpToAgent={(name) => {
                  setFocusAgent(name);
                  setView("agents");
                }}
              />,
            )}
            {renderView(
              "terminal",
              <Terminal
                root={root}
                visible={view === "terminal"}
                focus={focusSession}
                onFocusHandled={() => setFocusSession(null)}
              />,
            )}
            {renderView(
              "agents",
              <Agents
                ws={ws}
                root={root}
                focusAgent={focusAgent}
                focusTab={focusAgentTab}
                onFocusHandled={() => {
                  setFocusAgent(null);
                  setFocusAgentTab(null);
                }}
              />,
            )}
            {renderView(
              "worktrees",
              <Worktrees
                ws={ws}
                root={root}
                onOpenInTerminal={(name) => {
                  setFocusSession(name);
                  setView("terminal");
                }}
              />,
            )}
            {renderView(
              "review",
              <Review
                ws={ws}
                root={root}
                focusTicket={focusTicket}
                onFocusHandled={() => setFocusTicket(null)}
                onOpenInTerminal={(name) => {
                  setFocusSession(name);
                  setView("terminal");
                }}
                onWatchAgent={(name) => {
                  setFocusAgent(name);
                  setFocusAgentTab("console");
                  setView("agents");
                }}
              />,
            )}
            {renderView("archive", <Archive root={root} />)}
            {renderView(
              "settings",
              <Settings root={root} onConfigSaved={() => load(root)} />,
            )}
          </section>
        </div>
      )}
      {onboarding}
    </main>
  );
}
