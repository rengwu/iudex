import { ReactNode, useEffect, useState } from "react";
import * as api from "../lib/api";
import { recheckTmux } from "../lib/sessions";
import Modal from "../components/Modal";
import Button from "../components/Button";
import { AgentsTab } from "./Settings";
import st from "./Settings.module.scss";

type StepConfig = {
  intro: string;
  actions?: ReactNode[];
  title: string;
  content: ReactNode;
};

// First-run setup popup. Step 1: the agent-command pool — machine-level and
// required for any spawn, so a fresh machine needs it before iudex can do its
// job (reuses the Settings editor; single source of truth). Step 2: tmux, the
// session-pool substrate — shown only when it's actually missing, with a
// one-click Homebrew install where possible and a copy-paste command otherwise.
// Dismissible — the app stays usable read-only and the empty-pool banner nudges
// back here. (A totally missing iudex binary is handled earlier, by its own
// blocking screen, since the GUI shells everything through the CLI.)
export default function Onboarding({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<number>(0);
  const [setup, setSetup] = useState<api.TmuxSetup | null>(null);
  useEffect(() => {
    api
      .tmuxSetup()
      .then(setSetup)
      .catch(() => setSetup(null));
  }, []);

  // Agents saved: done — unless tmux still needs installing (probe failed ⇒
  // assume fine; the Terminal/Agents views carry their own hint).
  const agentsSaved = () => {
    if (setup && !setup.installed) setStep(1);
    else onClose();
  };

  const steps: StepConfig[] = [
    {
      title: "Set up Agents",
      intro:
        "To get started, tell iudex which AI coding agent(s) to use on your tasks. Give it a name, then type the command that starts it — for example, `claude` or `pi`. You only need to do this once.",
      content: <AgentsTab hideRoles onSaveSuccess={agentsSaved} />,
    },
    {
      title: "Install tmux",
      intro: setup?.installed
        ? "tmux is ready — your agents and shells will run inside tmux sessions, so they keep working even when this app is closed."
        : "iudex runs your agents and shells inside tmux sessions, so they keep working even when this app is closed. tmux isn't installed on this machine yet — one last step.",
      content: setup && (
        <TmuxStep setup={setup} onStatus={setSetup} />
      ),
      actions: [
        setup?.installed ? (
          <Button key="done" variant="primary" size="md" onClick={onClose}>
            Finish
          </Button>
        ) : (
          <Button key="skip" variant="quiet" size="md" onClick={onClose}>
            Skip for now
          </Button>
        ),
      ],
    },
  ];

  return (
    <Modal
      title={steps[step].title}
      onClose={onClose}
      actions={steps[step].actions}
      dismissOnBackdrop={false}
    >
      <p
        className="muted"
        style={{ marginTop: 0, fontSize: 12, lineHeight: 1.5 }}
      >
        {steps[step].intro}
      </p>
      {steps[step].content}
    </Modal>
  );
}

// The tmux prerequisite card. Three faces: Homebrew found → a one-click
// install; no Homebrew → the right package-manager command with a Copy button
// and a Re-check for when the user has run it in their own terminal; installed
// (initially or after either path) → a confirmation. A successful install also
// re-probes the shared sessions store, so Terminal/Agents come alive without a
// restart.
function TmuxStep({
  setup,
  onStatus,
}: {
  setup: api.TmuxSetup;
  onStatus: (s: api.TmuxSetup) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const recheck = async () => {
    setErr(null);
    try {
      const s = await api.tmuxSetup();
      onStatus(s);
      if (s.installed) recheckTmux();
      else setErr("still not finding tmux — did the install finish?");
    } catch (e) {
      setErr(String(e));
    }
  };

  const install = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.installTmux();
      recheckTmux();
      onStatus(await api.tmuxSetup());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    void navigator.clipboard?.writeText(setup.installHint);
    setCopied(true);
  };

  return (
    <section className={st.card}>
      <div className={st.head}>
        <span className={st.title}>tmux</span>
        {setup.version && <code className={st.path}>{setup.version}</code>}
      </div>

      <div className={st.fields}>
        {setup.installed ? (
          <small className={st.note}>
            ✓ <code>{setup.version ?? "tmux"}</code> is installed — you're all
            set.
          </small>
        ) : setup.canInstall ? (
          <small className={st.note}>
            Homebrew was found on this machine, so iudex can install tmux for
            you (it runs <code>{setup.installHint}</code>). This can take a
            minute or two.
          </small>
        ) : (
          <small className={st.note}>
            Run this in a terminal, then come back and re-check:{" "}
            <code>{setup.installHint}</code>
          </small>
        )}
        {err && <small className={st.savedErr}>✗ {err}</small>}
      </div>

      {!setup.installed && (
        <div className={st.actions}>
          {setup.canInstall ? (
            <Button variant="primary" size="md" disabled={busy} onClick={install}>
              {busy ? "Installing…" : "Install tmux"}
            </Button>
          ) : (
            <>
              <Button variant="secondary" size="md" onClick={copy}>
                {copied ? "Copied ✓" : "Copy command"}
              </Button>
              <Button variant="primary" size="md" onClick={recheck}>
                Re-check
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
