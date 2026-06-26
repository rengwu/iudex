import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AgentCmd, Config } from "../types";
import ViewHeader from "../components/ViewHeader";
import s from "./Settings.module.scss";

type Saved = { ok: boolean; msg: string } | null;
type SubTab = "cli" | "general" | "agents" | "prompts";

// Sidebar grouped by scope: GLOBAL settings live in ~/.iudex/ and apply to the
// app itself; WORKSPACE settings are the per-project .iudex/ files and need an
// open workspace.
const GROUPS: {
  head: string;
  scope: "global" | "workspace";
  items: { id: SubTab; label: string }[];
}[] = [
  { head: "GLOBAL", scope: "global", items: [{ id: "cli", label: "iudex CLI" }] },
  {
    head: "WORKSPACE",
    scope: "workspace",
    items: [
      { id: "general", label: "General" },
      { id: "agents", label: "Agents" },
      { id: "prompts", label: "Prompts" },
    ],
  },
];

const SUBTITLES: Record<SubTab, string> = {
  cli: "~/.iudex/settings.json",
  general: ".iudex/config.yml",
  agents: ".iudex/config.yml",
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
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    if (!root) return;
    let alive = true;
    Promise.all([
      api.readConfig(root),
      api.readPrompt(root, "impl"),
      api.readPrompt(root, "review"),
      api.readPrompt(root, "resolve"),
    ])
      .then(([c, i, r, res]) => {
        if (!alive) return;
        setConfig(c);
        setImpl(i);
        setReview(r);
        setResolve(res);
        setLoadErr(null);
      })
      .catch((e) => alive && setLoadErr(String(e)));
    return () => {
      alive = false;
    };
  }, [root]);

  return (
    <div className={s.settings}>
      <ViewHeader dot="#8a8f99" title="Settings" subtitle={SUBTITLES[tab]} />
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
          {!root && <div className={s.sideHint}>open a workspace to edit its settings</div>}
        </div>

        <div className={s.body}>
          {tab === "cli" ? (
            <CliTab />
          ) : !root ? (
            <div className={s.loading}>open a workspace to edit its settings</div>
          ) : tab === "agents" ? (
            <AgentsTab root={root} />
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
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Result<String,String> from Rust serializes as {Ok: …} | {Err: …}.
type IudexSettings = {
  savedPath: string;
  envBin: string | null;
  resolved: { Ok: string } | { Err: string };
};

// GLOBAL tab: the iudex binary the GUI shells every command through, stored in
// ~/.iudex/settings.json. Saving validates the path first (the backend refuses a
// broken one and keeps the old value), so a typo can't strand the app.
function CliTab() {
  const [data, setData] = useState<IudexSettings | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Saved>(null);

  const loadSettings = async () => {
    const d = await api.getIudexSettings();
    setData(d);
    setPath(d.savedPath);
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
      ? "Using the saved path."
      : data.envBin
        ? "No saved path — using $IUDEX_BIN."
        : "No saved path — using ‘iudex’ from your PATH.";

  return (
    <section className={s.card}>
      <div className={s.head}>
        <span className={s.title}>iudex CLI</span>
        <code className={s.path}>~/.iudex/settings.json</code>
      </div>

      <div className={s.fields}>
        <label className="field">
          <span>Binary path</span>
          <div className={s.pathRow}>
            <input
              value={path}
              placeholder="iudex (from PATH)"
              spellCheck={false}
              onChange={(e) => {
                setPath(e.target.value);
                setSaved(null);
              }}
            />
            <button type="button" className={s.browse} onClick={browse}>
              Browse…
            </button>
          </div>
          <small className={s.note}>
            The binary the GUI runs every command through. Leave empty to fall back to{" "}
            <code>$IUDEX_BIN</code>, then <code>iudex</code> on your PATH.
          </small>
        </label>

        {data && (
          <small className={s.note}>
            {source}{" "}
            {"Ok" in data.resolved ? (
              <>Currently resolves to <code>{data.resolved.Ok}</code>.</>
            ) : (
              <span className={s.savedErr}>✗ {data.resolved.Err}</span>
            )}
          </small>
        )}
      </div>

      <div className={s.actions}>
        <SavedNote saved={saved} />
        <button disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

function SavedNote({ saved }: { saved: Saved }) {
  if (!saved) return null;
  return (
    <span className={saved.ok ? s.savedOk : s.savedErr}>
      {saved.ok ? "✓ " : "✗ "}
      {saved.msg}
    </span>
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
        <input value={config.mainBranch} onChange={(e) => set("mainBranch", e.target.value)} />
        <small className={`${s.note} ${s.caution}`}>
          ⚠ the canonical merge target — set at init; changing it affects activate/merge.
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
        <select value={config.mergeStrategy} onChange={(e) => set("mergeStrategy", e.target.value)}>
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
        <input value={config.branchPrefix} onChange={(e) => set("branchPrefix", e.target.value)} />
        <small className={`${s.note} ${s.caution}`}>
          ⚠ applies to new tickets only — existing worktrees keep their branch.
        </small>
      </label>
      </div>

      <div className={s.actions}>
        <SavedNote saved={saved} />
        <button disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save general"}
        </button>
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
}: {
  root: string;
  impl: string;
  setImpl: (v: string) => void;
  review: string;
  setReview: (v: string) => void;
  resolve: string;
  setResolve: (v: string) => void;
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
      </div>

      <div className={s.actions}>
        <SavedNote saved={saved} />
        <button disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save prompts"}
        </button>
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

// WORKSPACE tab: the agent-command pool (config.yml `agent_commands`) + the
// per-role map (`agent_roles`). The CLI resolves impl/qa inside `iudex spawn`
// and the GUI resolves resolve/idea, both off these same fields.
function AgentsTab({ root }: { root: string }) {
  const [commands, setCommands] = useState<AgentCmd[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Saved>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .readAgentConfig(root)
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
  }, [root]);

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
    setCommands((cs) => [...cs, { name: "", command: "", default: cs.length === 0 }]);
    touch();
  };
  const removeCmd = (i: number) => {
    setCommands((cs) => {
      const next = cs.filter((_, j) => j !== i);
      if (next.length && !next.some((c) => c.default)) next[0] = { ...next[0], default: true };
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
    if (new Set(names).size !== names.length) return "command names must be unique";
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
      for (const [k, v] of Object.entries(roles)) if (valid.has(v)) cleanRoles[k] = v;
      const trimmed = commands.map((c) => ({
        name: c.name.trim(),
        command: c.command.trim(),
        default: c.default,
      }));
      await api.writeAgentConfig(root, { commands: trimmed, roles: cleanRoles });
      await api.iudexStatus(root); // confirm the CLI can still parse it
      setRoles(cleanRoles);
      setSaved({ ok: true, msg: "saved" });
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
        <code className={s.path}>.iudex/config.yml</code>
      </div>

      <div className={s.fields}>
        <div className="field">
          <span>Command pool</span>
          <div className={s.agentPool}>
            {commands.length === 0 && <div className={s.note}>no commands yet</div>}
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
                <label className={s.agentDefault} title="default — used by any unmapped role">
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
          <button type="button" className={s.agentAdd} onClick={addCmd}>
            + add command
          </button>
        </div>

        <div className="field">
          <span>Role defaults</span>
          <div className={s.roleGrid}>
            {AGENT_ROLES.map((r) => (
              <div key={r.key} className={s.roleRow}>
                <span className={s.roleLabel}>
                  {r.label}
                  <small className={s.note}> · {r.hint}</small>
                </span>
                <select value={roles[r.key] ?? ""} onChange={(e) => setRole(r.key, e.target.value)}>
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
        <button disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save agents"}
        </button>
      </div>
    </section>
  );
}
