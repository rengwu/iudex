import { ReactNode, useState } from "react";
import Modal from "../components/Modal";
import { AgentsTab } from "./Settings";

type StepConfig = {
  intro: string;
  actions?: ReactNode[];
  title: string;
  content: ReactNode;
};

// First-run setup popup. The agent-command pool is machine-level and required
// for any spawn, so a fresh machine needs it before iudex can do its job. This
// guides the user through it, reusing the same Settings editors (single source of
// truth): Step 1 the required agent command, Step 2 the optional iudex-CLI path.
// Dismissible — the app stays usable read-only and the empty-pool banner nudges
// back here. (A totally missing iudex binary is handled earlier, by its own
// blocking screen, since the GUI shells everything through the CLI.)
export default function Onboarding({ onClose }: { onClose: () => void }) {
  // Single step for now (the optional CLI step is commented out below); keep the
  // index so re-enabling it is a one-line change.
  const [step] = useState<number>(0);

  const steps: StepConfig[] = [
    {
      title: "Set up Agents",
      intro:
        "To get started, tell iudex which AI coding agent(s) to use on your tasks. Give it a name, then type the command that starts it — for example, `claude` or `pi`. You only need to do this once.",
      content: <AgentsTab hideRoles onSaveSuccess={() => onClose()} />,
    },
    // {
    //   title: "CLI",
    //   intro:
    //     "Optional: point the GUI at a specific iudex binary. Skip this if iudex is already on your PATH.",
    //   content: (
    //     <CliTab
    //       extraActions={
    //         <button className="ghost" onClick={() => setStep((p) => p - 1)}>
    //           ← Back
    //         </button>
    //       }
    //       onSaveSuccess={() => onClose()}
    //     />
    //   ),
    // },
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
