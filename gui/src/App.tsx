import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { RAIL_VIEWS, RAIL_SECONDARY, type View, type Workspace } from "./types";
import { useSessions } from "./lib/sessions";
import Dashboard from "./views/Dashboard";
import Tickets from "./views/Tickets";
import Terminal from "./views/Terminal";
import Agents from "./views/Agents";
import Worktrees from "./views/Worktrees";
import Review from "./views/Review";
import Archive from "./views/Archive";
import Settings from "./views/Settings";
import SectionHeader from "./components/SectionHeader";
import Button from "./components/Button";
import Badge from "./components/Badge";
import "./styles/base.scss";
import a from "./App.module.scss";

// Keep a view mounted (state preserved) after switching away; prune it only
// after this much inactivity — a separate timer per view.
const KEEP_ALIVE_MS = 10 * 60 * 1000;

// GUI version: no real versioning scheme yet — placeholder until we wire one up
// (e.g. inject from package.json / git at build time, like the iudex binary).
const GUI_VERSION = "dev";

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export default function App() {
  // The last folder the user selected — retained for initHere even when it's
  // not a valid workspace yet.
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  // iudex CLI availability: null while checking, then the version line or null
  // once we know it's missing (the GUI is useless without the binary).
  const [iudexVersion, setIudexVersion] = useState<string | null>(null);
  const [iudexErr, setIudexErr] = useState<string | null>(null);
  const [checkingIudex, setCheckingIudex] = useState(true);
  // Standalone (workspace-less) Settings opened from the missing-binary splash,
  // so the user can point the GUI at an iudex binary and recover in place.
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [root, setRoot] = useState<string | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offerInit, setOfferInit] = useState(false);
  const [initing, setIniting] = useState(false);
  const [lastSync, setLastSync] = useState<string>("");
  // Land on Tickets: the Dashboard reskin is deferred (still the old dark style).
  const [view, setView] = useState<View>("tickets");
  const [focusSession, setFocusSession] = useState<string | null>(null);
  const [focusTicket, setFocusTicket] = useState<string | null>(null);
  const [focusAgent, setFocusAgent] = useState<string | null>(null);
  // When set alongside focusAgent, the Agents view opens that agent on this tab.
  const [focusAgentTab, setFocusAgentTab] = useState<string | null>(null);

  // ── View keep-alive ─────────────────────────────────────────────────────────
  // Views stay mounted (state intact) when switched away, and unmount only after
  // KEEP_ALIVE_MS of inactivity — one timer per view, reset on re-visit.
  const [mounted, setMounted] = useState<View[]>(["tickets"]);
  const prevViewRef = useRef<View>("tickets");
  const pruneTimers = useRef<Partial<Record<View, ReturnType<typeof setTimeout>>>>({});

  useEffect(() => {
    // Keep the active view mounted; cancel any pending prune for it.
    setMounted((m) => (m.includes(view) ? m : [...m, view]));
    const active = pruneTimers.current[view];
    if (active) {
      clearTimeout(active);
      delete pruneTimers.current[view];
    }
    // Start the inactivity timer for the view we just left.
    const prev = prevViewRef.current;
    if (prev !== view) {
      if (pruneTimers.current[prev]) clearTimeout(pruneTimers.current[prev]);
      pruneTimers.current[prev] = setTimeout(() => {
        setMounted((m) => m.filter((v) => v !== prev));
        delete pruneTimers.current[prev];
      }, KEEP_ALIVE_MS);
    }
    prevViewRef.current = view;
  }, [view]);

  // Clear all pending timers if the app itself unmounts.
  useEffect(() => {
    const timers = pruneTimers.current;
    return () => Object.values(timers).forEach((t) => t && clearTimeout(t));
  }, []);

  // The GUI shells every operation through the iudex CLI, so verify it's on PATH
  // before anything else — otherwise every command fails with an opaque error.
  const checkIudex = useCallback(async () => {
    setCheckingIudex(true);
    try {
      const v = await invoke<string>("check_iudex");
      setIudexVersion(v);
      setIudexErr(null);
    } catch (e) {
      setIudexVersion(null);
      setIudexErr(String(e));
    } finally {
      setCheckingIudex(false);
    }
  }, []);

  useEffect(() => {
    checkIudex();
  }, [checkIudex]);
  const [autoActivate, setAutoActivate] = useState(false);
  const autoActivateRef = useRef(false);
  const drainingRef = useRef(false);
  const skipRef = useRef<Set<string>>(new Set());
  const [autoQA, setAutoQA] = useState(false);
  const autoQARef = useRef(false);
  const qaDrainingRef = useRef(false);
  const qaHandledRef = useRef<Set<string>>(new Set());
  const { sessions } = useSessions();

  const aaKey = (r: string) => `iudex.autoActivate.${r}`;
  const qaKey = (r: string) => `iudex.autoQA.${r}`;

  const load = useCallback(async (r: string) => {
    try {
      const data = await invoke<Workspace>("iudex_status", { root: r });
      setWs(data);
      setError(null);
      setLastSync(new Date().toLocaleTimeString());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const enter = useCallback(
    async (r: string) => {
      setRoot(r);
      setError(null);
      setOfferInit(false);
      await load(r);
      await invoke("watch_workspace", { root: r });
    },
    [load]
  );

  async function pickAndOpen() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    const picked = Array.isArray(selected) ? selected[0] : selected;
    setPickedPath(picked);
    setError(null);
    setOfferInit(false);
    try {
      const r = await invoke<string>("discover_workspace", { start: picked });
      await enter(r);
    } catch (e) {
      const msg = String(e);
      setRoot(null);
      setWs(null);
      if (msg.includes("not inside an iudex workspace")) {
        setOfferInit(true);
      } else {
        setError(msg);
      }
    }
  }

  async function initHere() {
    if (!pickedPath) return;
    setIniting(true);
    try {
      const r = await invoke<string>("init_workspace", { path: pickedPath });
      await enter(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setIniting(false);
    }
  }

  useEffect(() => {
    if (!root) return;
    const un = listen("events-changed", () => load(root));
    return () => {
      un.then((f) => f());
    };
  }, [root, load]);

  useEffect(() => {
    if (!root) return;
    skipRef.current.clear();
    qaHandledRef.current.clear();
    setAutoActivate(localStorage.getItem(aaKey(root)) === "true");
    setAutoQA(localStorage.getItem(qaKey(root)) === "true");
  }, [root]);

  const toggleAutoActivate = useCallback(
    (v: boolean) => {
      autoActivateRef.current = v;
      skipRef.current.clear();
      if (root) localStorage.setItem(aaKey(root), String(v));
      setAutoActivate(v);
    },
    [root]
  );

  const toggleAutoQA = useCallback(
    (v: boolean) => {
      autoQARef.current = v;
      qaHandledRef.current.clear();
      if (root) localStorage.setItem(qaKey(root), String(v));
      setAutoQA(v);
    },
    [root]
  );

  useEffect(() => {
    if (!autoActivate || !root || !ws) return;
    if (drainingRef.current) return;
    if (!ws.tickets.some((t) => t.state === "queued" && t.ready)) return;
    drainingRef.current = true;
    (async () => {
      try {
        while (autoActivateRef.current) {
          const data = await invoke<Workspace>("iudex_status", { root });
          const next = data.tickets.find(
            (t) => t.state === "queued" && t.ready && !skipRef.current.has(t.id)
          );
          if (!next) break;
          try {
            await invoke("run_iudex", { root, args: ["activate", next.id] });
            await invoke("spawn_agent", { root, ticket: next.id, role: "impl" });
          } catch (e) {
            skipRef.current.add(next.id);
            setError(String(e));
          }
        }
      } finally {
        drainingRef.current = false;
        load(root);
      }
    })();
  }, [autoActivate, root, ws, load]);

  useEffect(() => {
    if (!autoQA || !root || !ws) return;
    const pendingQA = new Set(
      ws.tickets.filter((t) => t.state === "pending-qa").map((t) => t.id)
    );
    for (const id of qaHandledRef.current) {
      if (!pendingQA.has(id)) qaHandledRef.current.delete(id);
    }
    const candidates = [...pendingQA].filter((id) => !qaHandledRef.current.has(id));
    if (candidates.length === 0 || qaDrainingRef.current) return;
    qaDrainingRef.current = true;
    (async () => {
      try {
        for (const id of candidates) {
          if (!autoQARef.current) break;
          const qaSessions = sessions.filter(
            (s) => s.kind === "agent" && s.role === "qa" && s.ticket === id
          );
          let live = false;
          for (const s of qaSessions) {
            try {
              const st = await invoke<{ dead: boolean }>("session_status", {
                name: s.name,
              });
              if (!st.dead) {
                live = true;
                break;
              }
            } catch {
              // unknown → treat as not-live
            }
          }
          qaHandledRef.current.add(id);
          if (live) continue;
          try {
            await invoke("spawn_agent", { root, ticket: id, role: "qa" });
          } catch (e) {
            setError(String(e));
          }
        }
      } finally {
        qaDrainingRef.current = false;
      }
    })();
  }, [autoQA, root, ws, sessions]);

  // While either automation is on, poll the workspace every ~7s so the drains
  // above re-evaluate on a steady cadence (not only on the events doorbell) —
  // freeing slots / newly-queued / newly-pending-qa tickets get picked up.
  useEffect(() => {
    if (!root || (!autoActivate && !autoQA)) return;
    const h = setInterval(() => load(root), 7000);
    return () => clearInterval(h);
  }, [autoActivate, autoQA, root, load]);

  // ── First paint blocks on the iudex check; the GUI does nothing without it ──
  if (checkingIudex && !iudexVersion && !iudexErr) {
    return (
      <main className={a.app}>
        <div className={a.splash}>
          <h1 className={a.logo}>iudex</h1>
        </div>
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
              <p className={a.errLede}>The iudex command-line tool isn’t available.</p>
              <pre className={a.errCode}>{iudexErr}</pre>
              <p className={a.errHint}>
                iudex drives this app the way git drives a git client. Install the{" "}
                <code>iudex</code> binary and point the GUI at it — set the path in Settings,
                or put <code>iudex</code> on your PATH (or set <code>IUDEX_BIN</code>) and
                re-check.
              </p>
            </div>

            <footer className={a.errActions}>
              <Button variant="quiet" disabled={checkingIudex} onClick={checkIudex}>
                {checkingIudex ? "Checking…" : "Re-check"}
              </Button>
              <Button variant="primary" onClick={() => setShowGlobalSettings(true)}>
                Open Settings
              </Button>
            </footer>
          </section>
        </div>
      </main>
    );
  }

  // ── Splash: no workspace open yet ──────────────────────────────────────────
  if (!root && !offerInit) {
    return (
      <main className={a.app}>
        <div className={a.splash}>
          <h1 className={a.logo}>iudex</h1>
          <button className={a.openBtn} onClick={pickAndOpen}>
            Open Folder
          </button>
          <div className={a.versions}>
            <span>{iudexVersion ?? "iudex —"}</span>
            <span>gui {GUI_VERSION}</span>
          </div>
          {error && <div className="error">{error}</div>}
        </div>
      </main>
    );
  }

  // ── Not a workspace: offer to initialize ───────────────────────────────────
  if (offerInit) {
    return (
      <main className={a.app}>
        <div className={a.splash}>
          <p className={a.notWs}>not an iudex workspace</p>
          <button className={a.openBtn} disabled={initing} onClick={initHere}>
            {initing ? "Initializing…" : "Initialize"}
          </button>
          <button className={a.linkBtn} onClick={pickAndOpen}>
            open a different folder
          </button>
          {error && <div className="error">{error}</div>}
        </div>
      </main>
    );
  }

  // ── Workspace open ─────────────────────────────────────────────────────────
  const tickets = ws?.tickets ?? [];
  const cnt = (st: string) => tickets.filter((t) => t.state === st).length;
  const activeCount = cnt("active");
  const navCounts: Partial<Record<View, number>> = {
    terminal: sessions.length,
    tickets: tickets.filter((t) => t.state !== "removed").length,
    agents: sessions.filter((s) => s.kind === "agent").length,
    worktrees: new Set(
      tickets.filter((t) => t.hasWorktree && t.worktree).map((t) => t.worktree)
    ).size,
    review: cnt("pending-human-qa"),
    archive: cnt("done"),
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
          on ? { borderLeftColor: "#f4bc41", background: "#1f2e90", color: "#e8e9eb" } : undefined
        }
      >
        <span className={a.navDot} style={{ background: v.dot }} />
        <span className={a.navLabel}>{v.label}</span>
        {count !== undefined && count > 0 && (
          <span className={a.navCount} style={on ? { color: "#cdd2ff" } : undefined}>
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
      <header className={a.topbar}>
        <div className={a.brand}>
          <span className={a.brandDot} />
          <span className={a.brandName}>iudex</span>
        </div>
        <div
          className={a.wsPicker}
          onClick={pickAndOpen}
          title={`${root ?? ""}${lastSync ? ` · synced ${lastSync}` : ""}`}
        >
          <span className={a.wsTag}>WS</span>
          <span className={a.wsPath}>{root ? basename(root) : ""}</span>
          <span className={a.wsChev}>▾</span>
        </div>
        <div className={a.spacer} />
      </header>

      {root && ws && (
        <div className={a.body}>
          <nav className={a.rail}>
            <SectionHeader tone="dark" noBorder>
              VIEWS
            </SectionHeader>
            {RAIL_VIEWS.map(navButton)}

            <div className={a.railSpacer} />

            {RAIL_SECONDARY.map(navButton)}

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
                      <span key={i} className={`${a.sysSeg} ${i < activeCount ? a.on : ""}`} />
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
            {renderView(
              "dashboard",
              <Dashboard />,
            )}
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
    </main>
  );
}
