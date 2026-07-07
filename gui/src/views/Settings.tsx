import { ReactNode, useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { VIEWS, type AgentCmd, type Config } from "../types";
import ViewHeader from "../components/ViewHeader";
import Button from "../components/Button";
import Toggle from "../components/Toggle";
import s from "./Settings.module.scss";

type Saved = { ok: boolean; msg: string } | null;
type SubTab = "cli" | "behavior" | "general" | "agents" | "prompts";

// Sidebar grouped by scope: GLOBAL settings live in ~/.iudex/ and apply to the
// app/machine itself (no workspace needed); WORKSPACE settings are the
// per-project .iudex/ files and need an open workspace. The agent-command pool
// is machine-level, so it sits under GLOBAL alongside the iudex-CLI path.
const GROUPS: {
  head: string;
  scope: "global" | "workspace";
  items: { id: SubTab; label: string }[];
}[] = [
  {
    head: "GLOBAL",
    scope: "global",
    items: [
      { id: "cli", label: "CLI" },
      { id: "agents", label: "Agent commands" },
      { id: "behavior", label: "Behavior" },
    ],
  },
  {
    head: "WORKSPACE",
    scope: "workspace",
    items: [
      { id: "general", label: "General" },
      { id: "prompts", label: "Prompts" },
    ],
  },
];

const SUBTITLES: Record<SubTab, string> = {
  cli: "~/.iudex/config.yml",
  behavior: "~/.iudex/config.yml",
  general: "~/.iudex/config.yml",
  agents: "~/.iudex/config.yml",
  prompts: ".iudex/prompts/",
};

// The settings surface. The iudex-CLI tab (GLOBAL) edits the app-level binary
// path and works without a workspace; General/Prompts (WORKSPACE) edit the
// per-project files and need a `root`. `onClose`, when given, renders a Back
// control — used when Settings is opened standalone from the missing-binary
// splash to recover before any workspace exists.
export default function Settings({
  root,
  onConfigSaved,
  onClose,
}: {
  root: string | null;
  onConfigSaved: () => void;
  onClose?: () => void;
}) {
  const [tab, setTab] = useState<SubTab>(root ? "general" : "cli");
  const [config, setConfig] = useState<Config | null>(null);
  const [impl, setImpl] = useState("");
  const [review, setReview] = useState("");
  const [resolve, setResolve] = useState("");
  const [nudge, setNudge] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    if (!root) return;
    let alive = true;
    Promise.all([
      api.readConfig(root),
      api.readPrompt(root, "impl"),
      api.readPrompt(root, "review"),
      api.readPrompt(root, "resolve"),
      api.getResumeNudge(root),
    ])
      .then(([c, i, r, res, n]) => {
        if (!alive) return;
        setConfig(c);
        setImpl(i);
        setReview(r);
        setResolve(res);
        setNudge(n);
        setLoadErr(null);
      })
      .catch((e) => alive && setLoadErr(String(e)));
    return () => {
      alive = false;
    };
  }, [root]);

  return (
    <div className={s.settings}>
      <ViewHeader
        dot={VIEWS.settings.dot}
        title="Settings"
        subtitle={SUBTITLES[tab]}
      />
      <div className={s.row}>
        <div className={s.sidebar}>
          {onClose && (
            <button className={s.back} onClick={onClose}>
              ← Back
            </button>
          )}
          {GROUPS.map((g) => (
            <div key={g.head}>
              <div className={s.sideHead}>{g.head}</div>
              {g.items.map((t) => {
                const disabled = g.scope === "workspace" && !root;
                return (
                  <button
                    key={t.id}
                    className={`${s.sideItem} ${tab === t.id ? s.active : ""} ${
                      disabled ? s.disabled : ""
                    }`}
                    disabled={disabled}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          ))}
          {!root && (
            <div className={s.sideHint}>
              open a workspace to edit its settings
            </div>
          )}
        </div>

        <div className={s.body}>
          {tab === "cli" ? (
            <CliTab />
          ) : tab === "agents" ? (
            <AgentsTab />
          ) : tab === "behavior" ? (
            <BehaviorTab />
          ) : !root ? (
            <div className={s.loading}>
              open a workspace to edit its settings
            </div>
          ) : loadErr ? (
            <div className="error">{loadErr}</div>
          ) : !config ? (
            <div className={s.loading}>loading config…</div>
          ) : tab === "general" ? (
            <GeneralTab
              config={config}
              setConfig={setConfig}
              root={root}
              onConfigSaved={onConfigSaved}
            />
          ) : (
            <PromptsTab
              root={root}
              impl={impl}
              setImpl={setImpl}
              review={review}
              setReview={setReview}
              resolve={resolve}
              setResolve={setResolve}
              nudge={nudge}
              setNudge={setNudge}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// GLOBAL tab: the iudex CLI. Leads with the bundled-CLI card (the zero-setup
// default story); the custom-binary override — stored in ~/.iudex/config.yml —
// is demoted behind an "Advanced" disclosure, auto-opened only when it is in
// play (override set, resolution failing, or running unbundled). Saving
// validates the path first (the backend refuses a broken one and keeps the old
// value), so a typo can't strand the app.
export function CliTab({
  extraActions,
  onSaveSuccess,
}: {
  extraActions?: ReactNode;
  onSaveSuccess?: () => void;
}) {
  const [data, setData] = useState<api.IudexSettings | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Saved>(null);
  const [advOpen, setAdvOpen] = useState(false);
  const advDecided = useRef(false);

  const loadSettings = async () => {
    const d = await api.getIudexSettings();
    setData(d);
    setPath(d.savedPath);
    // Open the override section on first load only when it is actually in
    // play: an override is set, resolution is failing, or there is no bundled
    // CLI to fall back on (unbundled dev runs). Once only, so the user's own
    // open/close wins afterwards.
    if (!advDecided.current) {
      advDecided.current = true;
      if (d.savedPath || d.envBin || !d.bundled || "Err" in d.resolved)
        setAdvOpen(true);
    }
  };
  useEffect(() => {
    loadSettings().catch((e) => setSaved({ ok: false, msg: String(e) }));
  }, []);

  const browse = async () => {
    const sel = await openDialog({ directory: false, multiple: false });
    if (!sel) return;
    setPath(Array.isArray(sel) ? sel[0] : sel);
    setSaved(null);
  };

  const save = async () => {
    setBusy(true);
    setSaved(null);
    try {
      const version = await api.setIudexBin(path);
      setSaved({ ok: true, msg: version });
      onSaveSuccess?.();
      await loadSettings();
    } catch (e) {
      // Rejected: nothing was persisted; keep the typed text so it can be fixed.
      setSaved({ ok: false, msg: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const source = !data
    ? ""
    : data.savedPath
      ? "A custom path is set — the GUI uses it for everything."
      : data.envBin
        ? "No custom path — using $IUDEX_BIN from the environment."
        : data.bundled
          ? "No custom path — using the CLI that ships with the app."
          : "No custom path — using ‘iudex’ from your PATH.";

  return (
    <div className={s.stack}>
      <BundledCliCard />

      <button
        type="button"
        className={s.advToggle}
        onClick={() => setAdvOpen((o) => !o)}
      >
        <span className={s.twisty}>{advOpen ? "▾" : "▸"}</span>
        Advanced — use a different iudex binary
      </button>

      {advOpen && (
        <section className={s.card}>
          <div className={s.head}>
            <span className={s.title}>Custom binary</span>
            <code className={s.path}>~/.iudex/config.yml</code>
          </div>

          <div className={s.fields}>
            <label className="field">
              <span>Binary path</span>
              <div className={s.pathRow}>
                <input
                  value={path}
                  placeholder="/usr/local/bin/iudex"
                  spellCheck={false}
                  onChange={(e) => {
                    setPath(e.target.value);
                    setSaved(null);
                  }}
                />
                <Button variant="secondary" size="md" onClick={browse}>
                  Browse…
                </Button>
              </div>
              <small className={s.note}>
                Most people never need this: the GUI already uses its built-in
                CLI. Set a path here only to run a different{" "}
                <code>iudex</code> build — e.g. one you compiled yourself, or a
                system install you want the GUI and your terminal to share.
                Leave empty for the default (<code>$IUDEX_BIN</code> if set,
                then the built-in CLI, then <code>iudex</code> on your PATH).
              </small>
            </label>

            {data && (
              <small className={s.note}>
                {source}{" "}
                {"Ok" in data.resolved ? (
                  <>
                    Currently running <code>{data.resolved.Ok}</code>.
                  </>
                ) : (
                  <span className={s.savedErr}>✗ {data.resolved.Err}</span>
                )}
              </small>
            )}
          </div>

          <div className={s.actions}>
            <SavedNote saved={saved} />
            {extraActions}
            <Button variant="primary" size="md" disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

// The CLI shipped inside the app bundle. The GUI and its tmux sessions use it
// automatically (zero setup); this card lets the user's own terminal have it
// too, via a symlink into ~/.local/bin. Renders nothing when running unbundled
// (plain cargo/dev runs without the sidecar).
function BundledCliCard() {
  const [status, setStatus] = useState<api.CliInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Saved>(null);

  const load = () =>
    api
      .cliInstallStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  useEffect(() => {
    load();
  }, []);

  if (!status?.bundledVersion) return null;

  // Installed but resolving to something other than the bundled version: the
  // link is stale or points at a different binary — offer to relink.
  const outdated =
    status.installedPath !== null &&
    status.installedVersion !== status.bundledVersion;

  const install = async () => {
    setBusy(true);
    setSaved(null);
    try {
      const path = await api.installCli();
      setSaved({ ok: true, msg: `linked ${path}` });
      await load();
    } catch (e) {
      setSaved({ ok: false, msg: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={s.card}>
      <div className={s.head}>
        <span className={s.title}>Bundled CLI</span>
        <code className={s.path}>~/.local/bin/iudex</code>
      </div>

      <div className={s.fields}>
        <small className={s.note}>
          The <code>iudex</code> CLI comes built into this app (
          <code>{status.bundledVersion}</code>). The GUI and every agent it
          launches use it automatically — nothing to install. To type{" "}
          <code>iudex</code> in your own terminal too, link it into{" "}
          <code>~/.local/bin</code>.
        </small>
        {status.installedPath && (
          <small className={s.note}>
            ✓ Linked at <code>{status.installedPath}</code>
            {status.installedVersion ? <> ({status.installedVersion})</> : null}
            .{" "}
            {!status.binDirOnPath && (
              <span className={s.savedErr}>
                ~/.local/bin is not on your shell’s PATH — add{" "}
                <code>export PATH=&quot;$HOME/.local/bin:$PATH&quot;</code> to
                your shell profile.
              </span>
            )}
          </small>
        )}
      </div>

      <div className={s.actions}>
        <SavedNote saved={saved} />
        {(!status.installedPath || outdated) && (
          <Button variant="primary" size="md" disabled={busy} onClick={install}>
            {busy ? "Linking…" : outdated ? "Update link" : "Install CLI command"}
          </Button>
        )}
      </div>
    </section>
  );
}

function SavedNote({ saved }: { saved: Saved }) {
  if (!saved) return null;
  return (
    <span className={`${s.saved} ${saved.ok ? s.savedOk : s.savedErr}`}>
      {saved.ok ? "✓ " : "✗ "}
      {saved.msg}
    </span>
  );
}

// GLOBAL tab: machine-level GUI behavior prefs (~/.iudex/config.yml). Currently
// one toggle — whether a full quit tears down the tmux pool. Edits are local
// until Save (mirrors the other settings tabs).
function BehaviorTab() {
  const [killOnExit, setKillOnExit] = useState<boolean | null>(null);
  const [graceMinutes, setGraceMinutes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Saved>(null);

  useEffect(() => {
    api
      .getKillPoolOnExit()
      .then(setKillOnExit)
      .catch((e) => setSaved({ ok: false, msg: String(e) }));
    api
      .getRetireGraceMinutes()
      .then(setGraceMinutes)
      .catch((e) => setSaved({ ok: false, msg: String(e) }));
  }, []);

  const save = async () => {
    if (killOnExit === null || graceMinutes === null) return;
    setBusy(true);
    setSaved(null);
    try {
      await api.setKillPoolOnExit(killOnExit);
      await api.setRetireGraceMinutes(graceMinutes);
      setSaved({ ok: true, msg: "saved" });
    } catch (e) {
      setSaved({ ok: false, msg: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={s.card}>
      <div className={s.head}>
        <span className={s.title}>Behavior</span>
        <code className={s.path}>~/.iudex/config.yml</code>
      </div>

      <div className={s.fields}>
        <div className={s.toggleField}>
          <div className={s.toggleRow}>
            <span className={s.toggleLabel}>
              Kill running agents &amp; shells when the app fully quits
            </span>
            <Toggle
              checked={killOnExit ?? true}
              disabled={killOnExit === null}
              onChange={(v) => {
                setKillOnExit(v);
                setSaved(null);
              }}
            />
          </div>
          <small className={s.note}>
            On (default): quitting stops all agents and shells. Off: they keep
            running in the background and reattach next launch. Switching
            workspaces never stops them either way.
          </small>
        </div>

        <label className={`field ${s.narrow}`}>
          <span>Retire grace period (minutes)</span>
          <input
            type="number"
            min={0}
            step={1}
            value={graceMinutes ?? 10}
            disabled={graceMinutes === null}
            onChange={(e) => {
              setGraceMinutes(Math.max(0, Math.floor(Number(e.target.value)) || 0));
              setSaved(null);
            }}
          />
          <small className={s.note}>
            How long a superseded agent's session lingers before it is killed. 0 =
            immediately.
          </small>
        </label>
      </div>

      <div className={s.actions}>
        <SavedNote saved={saved} />
        <Button
          variant="primary"
          size="md"
          disabled={busy || killOnExit === null || graceMinutes === null}
          onClick={save}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}

function GeneralTab({
  config,
  setConfig,
  root,
  onConfigSaved,
}: {
  config: Config;
  setConfig: (c: Config) => void;
  root: string;
  onConfigSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Saved>(null);

  const set = <K extends keyof Config>(k: K, v: Config[K]) => {
    setConfig({ ...config, [k]: v });
    setSaved(null);
  };

  const save = async () => {
    setBusy(true);
    setSaved(null);
    try {
      await api.writeConfig(root, config);
      // Confirm the CLI can still parse what we wrote.
      await api.iudexStatus(root);
      onConfigSaved();
      setSaved({ ok: true, msg: "saved" });
    } catch (e) {
      setSaved({ ok: false, msg: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={s.card}>
      <div className={s.head}>
        <span className={s.title}>General · config.yml</span>
        <code className={s.path}>.iudex/config.yml</code>
      </div>

      <div className={s.fields}>
        <label className="field">
          <span>Main branch</span>
          <input
            value={config.mainBranch}
            onChange={(e) => set("mainBranch", e.target.value)}
          />
          <small className={`${s.note} ${s.caution}`}>
            ⚠ the canonical merge target — set at init; changing it affects
            activate/merge.
          </small>
        </label>

        <label className={`field ${s.narrow}`}>
          <span>Max active</span>
          <input
            type="number"
            value={config.maxActive}
            onChange={(e) => set("maxActive", Number(e.target.value))}
          />
          <small className={s.note}>0 = unlimited</small>
        </label>

        <label className={`field ${s.narrow}`}>
          <span>QA reject limit</span>
          <input
            type="number"
            value={config.qaRejectLimit}
            onChange={(e) => set("qaRejectLimit", Number(e.target.value))}
          />
          <small className={s.note}>≤ 0 = unlimited</small>
        </label>

        <label className={`field ${s.narrow}`}>
          <span>Merge strategy</span>
          <select
            value={config.mergeStrategy}
            onChange={(e) => set("mergeStrategy", e.target.value)}
          >
            <option value="no-ff">no-ff</option>
            <option value="squash">squash</option>
          </select>
        </label>

        <label className="field">
          <span>Merge message template</span>
          <input
            value={config.mergeMessageTemplate}
            onChange={(e) => set("mergeMessageTemplate", e.target.value)}
          />
          <small className={s.note}>
            <code>{"{{.Ticket}}"}</code> is substituted with the ticket id.
          </small>
        </label>

        <label className="field">
          <span>Branch prefix</span>
          <input
            value={config.branchPrefix}
            onChange={(e) => set("branchPrefix", e.target.value)}
          />
          <small className={`${s.note} ${s.caution}`}>
            ⚠ applies to new tickets only — existing worktrees keep their
            branch.
          </small>
        </label>
      </div>

      <div className={s.actions}>
        <SavedNote saved={saved} />
        <Button variant="primary" size="md" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save general"}
        </Button>
      </div>
    </section>
  );
}

function PromptsTab({
  root,
  impl,
  setImpl,
  review,
  setReview,
  resolve,
  setResolve,
  nudge,
  setNudge,
}: {
  root: string;
  impl: string;
  setImpl: (v: string) => void;
  review: string;
  setReview: (v: string) => void;
  resolve: string;
  setResolve: (v: string) => void;
  nudge: string;
  setNudge: (v: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Saved>(null);

  const save = async () => {
    setBusy(true);
    setSaved(null);
    try {
      await api.writePrompt(root, "impl", impl);
      await api.writePrompt(root, "review", review);
      await api.writePrompt(root, "resolve", resolve);
      await api.setResumeNudge(root, nudge);
      setSaved({ ok: true, msg: "saved" });
    } catch (e) {
      setSaved({ ok: false, msg: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={s.card}>
      <div className={s.head}>
        <span className={s.title}>Prompt templates</span>
        <code className={s.path}>.iudex/prompts/</code>
      </div>

      <div className={s.fields}>
        <label className="field">
          <span>
            Impl prompt <code className={s.path}>impl.md</code>
          </span>
          <textarea
            className={s.prompt}
            rows={14}
            value={impl}
            onChange={(e) => {
              setImpl(e.target.value);
              setSaved(null);
            }}
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>
            Review prompt <code className={s.path}>review.md</code>
          </span>
          <textarea
            className={s.prompt}
            rows={14}
            value={review}
            onChange={(e) => {
              setReview(e.target.value);
              setSaved(null);
            }}
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>
            Resolve prompt <code className={s.path}>resolve.md</code>
          </span>
          <textarea
            className={s.prompt}
            rows={14}
            value={resolve}
            onChange={(e) => {
              setResolve(e.target.value);
              setSaved(null);
            }}
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>
            Resume nudge <code className={s.path}>gui_resume_nudge</code>
          </span>
          <input
            value={nudge}
            onChange={(e) => {
              setNudge(e.target.value);
              setSaved(null);
            }}
            spellCheck={false}
          />
          <small className={s.note}>
            The line the Agents “Resume” action types (+ Enter) into a stalled
            agent's console. Harness-neutral; blank restores the default.
          </small>
        </label>
      </div>

      <div className={s.actions}>
        <SavedNote saved={saved} />
        <Button variant="primary" size="md" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save prompts"}
        </Button>
      </div>
    </section>
  );
}

// The four roles the GUI exposes (the schema's role map is open; consumers
// ignore unknown keys). impl/qa are consumed by `iudex spawn`; resolve/idea by
// the GUI's tmux spawns.
const AGENT_ROLES: { key: string; label: string; hint: string }[] = [
  { key: "impl", label: "Impl", hint: "active ticket" },
  { key: "qa", label: "QA", hint: "pending-qa review" },
  { key: "resolve", label: "Resolve", hint: "merge-conflict resolver" },
  { key: "idea", label: "Idea", hint: "skill shaping" },
];

// GLOBAL tab: the machine-level agent-command pool (~/.iudex/config.yml
// `agent_commands`) + the per-role map (`agent_roles`), shared across every
// workspace. The CLI resolves impl/qa inside `iudex spawn` and the GUI resolves
// resolve/idea, both off these same fields. No workspace needed.
export function AgentsTab({
  hideRoles,
  onSaveSuccess,
}: {
  hideRoles?: boolean;
  onSaveSuccess?: () => void;
}) {
  const [commands, setCommands] = useState<AgentCmd[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Saved>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .readAgentConfig()
      .then((a) => {
        if (!alive) return;
        setCommands(a.commands);
        setRoles(a.roles);
        setLoadErr(null);
      })
      .catch((e) => alive && setLoadErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const touch = () => setSaved(null);
  const patchCmd = (i: number, p: Partial<AgentCmd>) => {
    setCommands((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));
    touch();
  };
  const makeDefault = (i: number) => {
    setCommands((cs) => cs.map((c, j) => ({ ...c, default: j === i })));
    touch();
  };
  const addCmd = () => {
    setCommands((cs) => [
      ...cs,
      { name: "", command: "", default: cs.length === 0 },
    ]);
    touch();
  };
  const removeCmd = (i: number) => {
    setCommands((cs) => {
      const next = cs.filter((_, j) => j !== i);
      if (next.length && !next.some((c) => c.default))
        next[0] = { ...next[0], default: true };
      return next;
    });
    touch();
  };
  const setRole = (key: string, name: string) => {
    setRoles((r) => {
      const n = { ...r };
      if (name) n[key] = name;
      else delete n[key];
      return n;
    });
    touch();
  };

  const names = commands.map((c) => c.name.trim()).filter(Boolean);
  const validate = (): string | null => {
    if (commands.length === 0) return "add at least one command";
    if (commands.some((c) => !c.name.trim() || !c.command.trim()))
      return "every entry needs a name and a command";
    if (new Set(names).size !== names.length)
      return "command names must be unique";
    if (!commands.some((c) => c.default)) return "mark one entry as default";
    return null;
  };

  const save = async () => {
    const err = validate();
    if (err) {
      setSaved({ ok: false, msg: err });
      return;
    }
    setBusy(true);
    setSaved(null);
    try {
      const valid = new Set(names);
      const cleanRoles: Record<string, string> = {};
      for (const [k, v] of Object.entries(roles))
        if (valid.has(v)) cleanRoles[k] = v;
      const trimmed = commands.map((c) => ({
        name: c.name.trim(),
        command: c.command.trim(),
        default: c.default,
      }));
      await api.writeAgentConfig({ commands: trimmed, roles: cleanRoles });
      // Confirm the CLI can parse what we wrote: read it back via `config --json`.
      // A parse failure surfaces as an empty pool, so a count mismatch flags it.
      const back = await api.readAgentConfig();
      if (back.commands.length !== trimmed.length) {
        throw new Error("the CLI could not parse the saved config");
      }
      setRoles(cleanRoles);
      setSaved({ ok: true, msg: "saved" });
      onSaveSuccess?.();
    } catch (e) {
      setSaved({ ok: false, msg: String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (loadErr) return <div className="error">{loadErr}</div>;

  return (
    <section className={s.card}>
      <div className={s.head}>
        <span className={s.title}>Agent commands</span>
        <code className={s.path}>~/.iudex/config.yml</code>
      </div>

      <div className={s.fields}>
        <div className="field">
          <span>Command pool</span>
          <div className={s.agentPool}>
            {commands.length === 0 && (
              <div className={s.note}>no commands yet</div>
            )}
            {commands.map((c, i) => (
              <div key={i} className={s.agentRow}>
                <input
                  className={s.agentName}
                  placeholder="name"
                  value={c.name}
                  spellCheck={false}
                  onChange={(e) => patchCmd(i, { name: e.target.value })}
                />
                <input
                  className={s.agentCmd}
                  placeholder="command — e.g. claude --model …"
                  value={c.command}
                  spellCheck={false}
                  onChange={(e) => patchCmd(i, { command: e.target.value })}
                />
                <label
                  className={s.agentDefault}
                  title="default — used by any unmapped role"
                >
                  <input
                    type="radio"
                    name="agent-default"
                    checked={c.default}
                    onChange={() => makeDefault(i)}
                  />
                  default
                </label>
                <button
                  type="button"
                  className={s.agentDel}
                  title="remove"
                  onClick={() => removeCmd(i)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <Button
            variant="secondary"
            size="md"
            onClick={addCmd}
            style={{ alignSelf: "flex-start", marginTop: 7 }}
          >
            + add command
          </Button>
        </div>

        <div className="field" style={hideRoles ? { display: "none" } : {}}>
          <span>Role defaults</span>
          <div className={s.roleGrid}>
            {AGENT_ROLES.map((r) => (
              <div key={r.key} className={s.roleRow}>
                <span className={s.roleLabel}>
                  {r.label}
                  <small className={s.note}> · {r.hint}</small>
                </span>
                <select
                  value={roles[r.key] ?? ""}
                  onChange={(e) => setRole(r.key, e.target.value)}
                >
                  <option value="">(default)</option>
                  {commands
                    .filter((c) => c.name.trim())
                    .map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={s.actions}>
        <SavedNote saved={saved} />
        <Button variant="primary" size="md" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save agents"}
        </Button>
      </div>
    </section>
  );
}
